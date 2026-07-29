/* ==========================================================================
   Lógica del Módulo de Facturación No Fiscal - Mundocarnes
   ========================================================================== */

// URL de la API de Google Apps Script
const API_URL_GAS = "https://script.google.com/macros/s/AKfycbwioDKH4HuEZoaZfw5YvbmPI4450jipV4oNBVcZcqtCciRWCM3-s8T98pU9vS9VjSbz/exec";

// Clasificación de Métodos por Naturaleza de Moneda
const METODOS_USD = ["Efectivo Divisas", "Zelle", "PayPal", "Cashea"];
const METODOS_BS = ["Pago Móvil", "Efectivo Bolívares", "Punto de Venta", "Transferencia Bancaria"];

let itemsFactura = {};
let productoTemporalFactura = {};
let cacheCategoriasFactura = [];
let clienteFacturaActual = null;
let monedaVistaModal = "USD"; // Estado del conmutador: "USD" o "BS"
let datosFacturaPendiente = null;

// Notificaciones Toast
function mostrarAvisoFactura(mensaje) {
  try {
    document.getElementById('toastMensajeFactura').textContent = mensaje;
    bootstrap.Toast.getOrCreateInstance(document.getElementById('toastFactura')).show();
  } catch (e) {
    alert(mensaje);
  }
}

// OBTENER LA TASA BCV ACTUAL DE FORMA SEGURA
function obtenerTasaBCV() {
  const inputTasa = document.getElementById('facTasaBCV');
  if (!inputTasa) return 0;
  return parseFloat(inputTasa.value) || 0;
}

// ALTERNAR ENTRE DIVISAS ($) Y BOLÍVARES (Bs) EN LA TABLA DEL MODAL
function alternarMonedaTablaFactura() {
  monedaVistaModal = (monedaVistaModal === "USD") ? "BS" : "USD";
  
  const btn = document.getElementById('btnConmutarMoneda');
  if (btn) {
    if (monedaVistaModal === "BS") {
      btn.textContent = "💵 Ver en Divisas ($)";
      btn.className = "btn btn-sm btn-dark fw-bold";
    } else {
      btn.textContent = "💱 Ver en Bolívares (Bs)";
      btn.className = "btn btn-sm btn-outline-dark fw-bold";
    }
  }

  renderizarTablaModalFactura();
  calcularTotalPagoMixto();
}

// RENDERIZAR TABLA DE PRODUCTOS EN EL MODAL SEGÚN MONEDA Y PESO REAL
function renderizarTablaModalFactura() {
  const tasa = obtenerTasaBCV();
  let htmlTabla = "";
  let totalUSD = 0;

  for (let key in itemsFactura) {
    let item = itemsFactura[key];
    let precioTotalUSD = parseFloat(item.precioTotal) || 0;
    let precioBaseUSD = parseFloat(item.precioBase) || 0;
    totalUSD += precioTotalUSD;

    let precioBaseTxt = "";
    let subtotalTxt = "";

    if (monedaVistaModal === "BS") {
      let precioBaseBs = precioBaseUSD * tasa;
      let subtotalBs = precioTotalUSD * tasa;

      let unidadBs = (item.unidad === 'gramos' || item.unidad === 'mixto') ? '/ Kg' : '/ Ud';
      precioBaseTxt = `Bs. ${precioBaseBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unidadBs}`;
      subtotalTxt = `Bs. ${subtotalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
      let unidadUsd = (item.unidad === 'gramos' || item.unidad === 'mixto') ? '/ Kg' : '/ Ud';
      precioBaseTxt = `$${precioBaseUSD.toFixed(2)} ${unidadUsd}`;
      subtotalTxt = `$${precioTotalUSD.toFixed(2)}`;
    }

    let imgRuta = item.imgPath || '../img/LOGO-MUNDO123.webp';

    // Celda de Cantidad / Peso
    let colCantidadHtml = item.cantidadTxt;
    if (item.unidad === 'mixto') {
      let pesoGramosActual = item.pesoTotalGramos || 0;
      colCantidadHtml = `
        <div class="d-flex align-items-center justify-content-center gap-1">
          <span class="small fw-bold">${item.cantNumerica} uds (</span>
          <input type="number" class="form-control form-control-sm text-center fw-bold border-dark p-1 text-danger" style="width: 85px;" value="${pesoGramosActual}" min="1" step="10" oninput="ajustarPesoMixtoFactura('${key}', this.value)" title="Modificar peso real de balanza en gramos">
          <span class="small fw-bold">g)</span>
        </div>`;
    }

    let safeIdKey = key.replace(/[^a-zA-Z0-9]/g, '_');

    htmlTabla += `
      <tr>
        <td class="text-center">
          <img src="${imgRuta}" class="img-thumb-factura" alt="${key}">
        </td>
        <td class="fw-bold">${key}</td>
        <td class="text-center">${precioBaseTxt}</td>
        <td class="text-center fw-bold">${colCantidadHtml}</td>
        <td class="text-end fw-bold text-success" id="subtotal-modal-${safeIdKey}">${subtotalTxt}</td>
      </tr>`;
  }

  const tbody = document.getElementById('tablaModalResumenProductos');
  if (tbody) tbody.innerHTML = htmlTabla;

  // Actualizar Totales del modal
  const elemEtiquetaTotal = document.getElementById('labelModalTotalFactura');
  const elemMontoTotal = document.getElementById('montoModalTotalFactura');

  if (monedaVistaModal === "BS") {
    let totalBs = totalUSD * tasa;
    if (elemEtiquetaTotal) elemEtiquetaTotal.textContent = "TOTAL FACTURA (Bs):";
    if (elemMontoTotal) elemMontoTotal.textContent = `Bs. ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else {
    if (elemEtiquetaTotal) elemEtiquetaTotal.textContent = "TOTAL FACTURA ($):";
    if (elemMontoTotal) elemMontoTotal.textContent = `$${totalUSD.toFixed(2)}`;
  }
}

// RECALCULAR PESO REAL Y SUBTOTALES PARA PRODUCTOS MIXTOS (POLLO ENTERO, LOMITO)
function ajustarPesoMixtoFactura(nombreProducto, nuevoPesoGramos) {
  let item = itemsFactura[nombreProducto];
  if (!item) return;

  let g = parseFloat(nuevoPesoGramos) || 0;
  item.pesoTotalGramos = g;

  let calc = (item.precioBase / 1000) * g;
  item.precioTotal = calc.toFixed(2);

  let kg = Math.floor(g / 1000);
  let rest = g % 1000;
  let pesoTxt = kg > 0 ? (rest > 0 ? `${kg}Kg ${rest}g` : `${kg}Kg`) : `${rest}g`;
  item.cantidadTxt = `${item.cantNumerica} uds (~${pesoTxt})`;

  const tasa = obtenerTasaBCV();
  let safeIdKey = nombreProducto.replace(/[^a-zA-Z0-9]/g, '_');
  const elemSubtotal = document.getElementById('subtotal-modal-' + safeIdKey);

  if (elemSubtotal) {
    if (monedaVistaModal === "BS") {
      let subBs = calc * tasa;
      elemSubtotal.textContent = `Bs. ${subBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
      elemSubtotal.textContent = `$${calc.toFixed(2)}`;
    }
  }

  actualizarCalculosBCV();
  renderizarResumenFactura();
}

// ACTUALIZAR CÁLCULOS BCV Y RE-RENDERIZAR
function actualizarCalculosBCV() {
  const tasa = obtenerTasaBCV();
  const usuario = sessionStorage.getItem("factura_usuario") || "global";
  localStorage.setItem("tasa_bcv_user_" + usuario, tasa);

  let totalUSD = 0;
  for (let key in itemsFactura) {
    totalUSD += parseFloat(itemsFactura[key].precioTotal) || 0;
  }
  let totalBs = totalUSD * tasa;

  const elemModalTotalBs = document.getElementById('montoModalTotalFacturaBs');
  if (elemModalTotalBs) {
    elemModalTotalBs.textContent = `Bs. ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  const elemEtiquetaTotal = document.getElementById('labelModalTotalFactura');
  const elemMontoTotal = document.getElementById('montoModalTotalFactura');

  if (monedaVistaModal === "BS") {
    if (elemEtiquetaTotal) elemEtiquetaTotal.textContent = "TOTAL FACTURA (Bs):";
    if (elemMontoTotal) elemMontoTotal.textContent = `Bs. ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else {
    if (elemEtiquetaTotal) elemEtiquetaTotal.textContent = "TOTAL FACTURA ($):";
    if (elemMontoTotal) elemMontoTotal.textContent = `$${totalUSD.toFixed(2)}`;
  }

  if (typeof calcularTotalPagoMixto === "function") {
    calcularTotalPagoMixto();
  }
}

// FUNCIONES PRODUCTO MANUAL (FUERA DE CATÁLOGO)
function abrirModalProductoManual() {
  document.getElementById('manualNombre').value = "";
  document.getElementById('manualPrecioUd').value = "";
  document.getElementById('manualCantUd').value = "1";
  document.getElementById('manualPrecioKg').value = "";
  document.getElementById('manualKg').value = "";
  document.getElementById('manualGramos').value = "";
  document.getElementById('manualModoVenta').value = "unidades";

  alternarCamposManual("unidades");
  document.getElementById('errorModalManual').classList.add('hidden');

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProductoManual')).show();
}

function alternarCamposManual(modo) {
  const contUds = document.getElementById('contManualUnidades');
  const contPeso = document.getElementById('contManualPeso');
  if (modo === "unidades") {
    contUds.classList.remove('hidden');
    contPeso.classList.add('hidden');
  } else {
    contUds.classList.add('hidden');
    contPeso.classList.remove('hidden');
  }
}

function confirmarAgregarProductoManual() {
  const nombre = document.getElementById('manualNombre').value.trim().toUpperCase();
  const modo = document.getElementById('manualModoVenta').value;
  const errorDiv = document.getElementById('errorModalManual');

  if (!nombre) {
    errorDiv.textContent = "Indique el nombre o descripción del producto.";
    errorDiv.classList.remove('hidden');
    return;
  }

  if (modo === "unidades") {
    let precioUd = parseFloat(document.getElementById('manualPrecioUd').value);
    let cant = parseInt(document.getElementById('manualCantUd').value);

    if (isNaN(precioUd) || precioUd <= 0 || isNaN(cant) || cant < 1) {
      errorDiv.textContent = "Indique precio unitario y cantidad válida.";
      errorDiv.classList.remove('hidden');
      return;
    }

    let calc = precioUd * cant;

    itemsFactura[nombre] = {
      cantidadTxt: `${cant} uds`,
      cantNumerica: cant,
      pesoTotalGramos: 0,
      precioTotal: calc.toFixed(2),
      precioBase: precioUd,
      unidad: "unidades",
      minBase: 1,
      pesoPromedio: 0,
      imgPath: '../img/LOGO-MUNDO123.webp',
      esManual: true
    };

  } else {
    let precioKg = parseFloat(document.getElementById('manualPrecioKg').value);
    let kg = parseFloat(document.getElementById('manualKg').value) || 0;
    let g = parseFloat(document.getElementById('manualGramos').value) || 0;
    let totalGramos = (kg * 1000) + g;

    if (isNaN(precioKg) || precioKg <= 0 || totalGramos <= 0) {
      errorDiv.textContent = "Indique precio por Kilo y un peso mayor a 0g.";
      errorDiv.classList.remove('hidden');
      return;
    }

    let calc = (precioKg / 1000) * totalGramos;
    let cantTxt = kg > 0 ? (g > 0 ? `${kg} Kg ${g} g` : `${kg} Kg`) : `${g} g`;

    itemsFactura[nombre] = {
      cantidadTxt: cantTxt,
      cantNumerica: totalGramos,
      pesoTotalGramos: totalGramos,
      precioTotal: calc.toFixed(2),
      precioBase: precioKg,
      unidad: "gramos",
      minBase: 1,
      pesoPromedio: 0,
      imgPath: '../img/LOGO-MUNDO123.webp',
      esManual: true
    };
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProductoManual')).hide();
  renderizarResumenFactura();

  const modalProcesar = document.getElementById('modalProcesarFactura');
  if (modalProcesar && modalProcesar.classList.contains('show')) {
    renderizarTablaModalFactura();
    actualizarCalculosBCV();
  }

  mostrarAvisoFactura(`Producto manual agregado: ${nombre}`);
}

// Inicio de Sesión
async function procesarLoginFacturacion(event) {
  event.preventDefault();
  
  const usuario = document.getElementById('facUsuario').value.trim();
  const password = document.getElementById('facPassword').value.trim();
  const btn = document.getElementById('btnIngresarFac');

  if (!usuario || !password) {
    return mostrarAvisoFactura("Ingrese usuario y contraseña.");
  }

  btn.disabled = true;
  btn.textContent = "Verificando...";

  try {
    const response = await fetch(API_URL_GAS, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "loginFacturacion",
        usuario: usuario,
        password: password
      })
    });

    const res = await response.json();
    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema 🔐";

    if (res.status === "success") {
      sessionStorage.setItem("factura_token", res.token);
      sessionStorage.setItem("factura_usuario", res.usuario);
      iniciarModuloFacturacion(res.usuario);
    } else {
      mostrarAvisoFactura(res.message || "Credenciales incorrectas.");
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema 🔐";
    mostrarAvisoFactura("Error de conexión al autenticar.");
    console.error("Error Login:", err);
  }
}

function iniciarModuloFacturacion(usuario) {
  document.getElementById('vistaLogin').classList.add('hidden');
  document.getElementById('vistaFacturacion').classList.remove('hidden');
  document.getElementById('usuarioActivo').textContent = `👤 Usuario: ${usuario.toUpperCase()}`;
  
  cargarCatalogoFacturacion();
}

function cerrarSesionFacturacion() {
  sessionStorage.removeItem("factura_token");
  sessionStorage.removeItem("factura_usuario");
  itemsFactura = {};
  clienteFacturaActual = null;
  document.getElementById('vistaFacturacion').classList.add('hidden');
  document.getElementById('vistaLogin').classList.remove('hidden');
  document.getElementById('facUsuario').value = "";
  document.getElementById('facPassword').value = "";
}

// Carga del Catálogo desde la carpeta raíz
function cargarCatalogoFacturacion() {
  fetch("../catalog.json?t=" + new Date().getTime())
    .then(res => res.json())
    .then(renderizarCatalogoFacturacion)
    .catch(err => {
      console.error(err);
      mostrarAvisoFactura("Error al cargar ../catalog.json");
    });
}

function renderizarCatalogoFacturacion(resp) {
  if (resp.error) return alert(resp.error);
  
  cacheCategoriasFactura = resp.categorias || [];
  let tabsHtml = "";
  let contentHtml = "";

  cacheCategoriasFactura.forEach((cat, index) => {
    let activeClass = index === 0 ? "active" : "";
    let showActiveClass = index === 0 ? "show active" : "";
    let safeId = "factab-" + cat.nombre.replace(/\s+/g, '-').toLowerCase();

    tabsHtml += `
      <li class="nav-item">
        <button class="nav-link ${activeClass}" data-bs-toggle="tab" data-bs-target="#${safeId}" type="button">${cat.nombre}</button>
      </li>`;

    contentHtml += `
      <div class="tab-pane fade ${showActiveClass}" id="${safeId}">
        <div id="lista-${safeId}" class="row g-3 pt-2"></div>
      </div>`;
  });

  document.getElementById('facturaTabs').innerHTML = tabsHtml;
  document.getElementById('facturaTabContent').innerHTML = contentHtml;

  cacheCategoriasFactura.forEach((cat) => {
    let safeId = "factab-" + cat.nombre.replace(/\s+/g, '-').toLowerCase();
    cargarListaFacturacion("lista-" + safeId, cat.productos, cat.nombre);
  });
}

function cargarListaFacturacion(idElemento, productos, nombreCategoria) {
  document.getElementById(idElemento).innerHTML = productos.map(f => {
    let nom = f[0];
    let prec = f[1];
    let imgPath = f[2].startsWith('../') ? f[2] : '../' + f[2];
    let esDisp = f[3];
    let cantMin = f[4];
    let unidad = f[5];
    let pesoPromedio = f[6] || 0;

    let claseImg = esDisp ? "" : "img-agotado";
    let boton = esDisp 
      ? `<button class="btn btn-sm btn-outline-danger fw-bold mt-2 w-100" onclick="abrirModalAgregarFactura('${nom}', ${prec}, '${nombreCategoria}', ${cantMin}, '${unidad}', ${pesoPromedio}, '${imgPath}')">+ Seleccionar</button>`
      : `<button class="btn btn-sm btn-secondary fw-bold mt-2 w-100" disabled>Agotado</button>`;

    let unidadTxt = (unidad === 'gramos') ? 'g' : 'uds';

    return `
      <div class="col-6 col-md-4 col-xl-3">
        <div class="card card-producto h-100 p-2 text-center">
          <img src="${imgPath}" loading="lazy" class="${claseImg}">
          <h6 class="fw-bold mt-2 text-truncate mb-1">${nom}</h6>
          <p class="text-success fw-bold mb-0">$${prec.toFixed(2)}</p>
          <small class="text-muted" style="font-size:0.75rem;">Mín: ${cantMin} ${unidadTxt}</small>
          ${boton}
        </div>
      </div>`;
  }).join('');
}

// Modal de Cantidad / Peso
function abrirModalAgregarFactura(nom, prec, cat, cantMin, unidad, pesoProm, imgPath) {
  productoTemporalFactura = { 
    nombre: nom, 
    precio: prec, 
    categoria: cat, 
    minBase: cantMin, 
    unidad: unidad, 
    pesoPromedio: pesoProm,
    imgPath: imgPath
  };

  document.getElementById('modalNombreProducto').textContent = nom;
  document.getElementById('modalPrecioProducto').textContent = `$${prec.toFixed(2)}`;

  const contUds = document.getElementById('contFacUnidades');
  const contPeso = document.getElementById('contFacPeso');
  const errorDiv = document.getElementById('errorModalFac');
  errorDiv.classList.add('hidden');

  if (unidad === 'unidades' || unidad === 'mixto') {
    contUds.classList.remove('hidden');
    contPeso.classList.add('hidden');
    let inp = document.getElementById('inputFacUnidades');
    inp.min = cantMin;
    inp.value = cantMin;
  } else {
    contUds.classList.add('hidden');
    contPeso.classList.remove('hidden');
    document.getElementById('inputFacKg').value = "";
    document.getElementById('inputFacGramos').value = "";
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFacturaCantidad')).show();
}

function confirmarAgregarAFactura() {
  const errorDiv = document.getElementById('errorModalFac');
  const prod = productoTemporalFactura;

  if (prod.unidad === 'unidades' || prod.unidad === 'mixto') {
    let cant = parseInt(document.getElementById('inputFacUnidades').value);
    if (isNaN(cant) || cant < prod.minBase) {
      errorDiv.textContent = `Mínimo requerido: ${prod.minBase} uds.`;
      errorDiv.classList.remove('hidden');
      return;
    }

    let calc = 0;
    let cantTxt = cant + ' uds';
    let pesoTotalGramos = 0;

    if (prod.unidad === 'mixto') {
      pesoTotalGramos = cant * (prod.pesoPromedio || 0);
      calc = (prod.precio / 1000) * pesoTotalGramos;
      let kg = Math.floor(pesoTotalGramos / 1000);
      let g = pesoTotalGramos % 1000;
      let pesoTxt = kg > 0 ? (g > 0 ? `${kg}Kg ${g}g` : `${kg}Kg`) : `${g}g`;
      cantTxt = `${cant} uds (~${pesoTxt})`;
    } else {
      calc = prod.precio * cant;
    }

    itemsFactura[prod.nombre] = {
      cantidadTxt: cantTxt,
      cantNumerica: cant,
      pesoTotalGramos: pesoTotalGramos,
      precioTotal: calc.toFixed(2),
      precioBase: prod.precio,
      unidad: prod.unidad,
      minBase: prod.minBase,
      pesoPromedio: prod.pesoPromedio || 0,
      imgPath: prod.imgPath || '../img/LOGO-MUNDO123.webp'
    };

  } else {
    let kg = parseFloat(document.getElementById('inputFacKg').value) || 0;
    let g = parseFloat(document.getElementById('inputFacGramos').value) || 0;
    let totalGramos = (kg * 1000) + g;

    if (totalGramos < prod.minBase) {
      errorDiv.textContent = `El peso mínimo es ${prod.minBase}g.`;
      errorDiv.classList.remove('hidden');
      return;
    }

    let calc = (prod.precio / 1000) * totalGramos;
    let cantTxt = kg > 0 ? (g > 0 ? `${kg} Kg ${g} g` : `${kg} Kg`) : `${g} g`;

    itemsFactura[prod.nombre] = {
      cantidadTxt: cantTxt,
      cantNumerica: totalGramos,
      pesoTotalGramos: totalGramos,
      precioTotal: calc.toFixed(2),
      precioBase: prod.precio,
      unidad: prod.unidad,
      minBase: prod.minBase,
      pesoPromedio: 0,
      imgPath: prod.imgPath || '../img/LOGO-MUNDO123.webp'
    };
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFacturaCantidad')).hide();
  renderizarResumenFactura();
}

function renderizarResumenFactura() {
  let html = '<table class="table table-sm align-middle text-start"><tbody>';
  let totalAcumulado = 0;

  for (let key in itemsFactura) {
    let item = itemsFactura[key];
    totalAcumulado += parseFloat(item.precioTotal);

    html += `
      <tr>
        <td class="fw-bold small text-wrap">${key}</td>
        <td class="small text-muted">${item.cantidadTxt}</td>
        <td class="text-success fw-bold text-end">$${item.precioTotal}</td>
        <td class="text-end" style="width:30px">
          <button class="btn btn-sm btn-outline-danger py-0 px-1 border-0" onclick="eliminarItemFactura('${key}')">✕</button>
        </td>
      </tr>`;
  }

  html += '</tbody></table>';

  document.getElementById('contenedorListaFactura').innerHTML = Object.keys(itemsFactura).length 
    ? html 
    : '<p class="text-muted text-center py-3 small">No hay productos seleccionados.</p>';

  document.getElementById('montoTotalFactura').textContent = `$${totalAcumulado.toFixed(2)}`;
}

function eliminarItemFactura(nombre) {
  delete itemsFactura[nombre];
  renderizarResumenFactura();
}

// Acción del Botón 'Facturar'
function ejecutarFacturar() {
  if (Object.keys(itemsFactura).length === 0) {
    return mostrarAvisoFactura("Seleccione al menos un producto para facturar.");
  }

  monedaVistaModal = "USD";
  const btnConmutar = document.getElementById('btnConmutarMoneda');
  if (btnConmutar) {
    btnConmutar.textContent = "💱 Ver en Bolívares (Bs)";
    btnConmutar.className = "btn btn-sm btn-outline-dark fw-bold";
  }

  const selectPago = document.getElementById('facFormaPagoSelect');
  if (selectPago) selectPago.value = "";

  const contMixto = document.getElementById('contenedorPagoMixto');
  if (contMixto) contMixto.classList.add('hidden');

  const usuario = sessionStorage.getItem("factura_usuario") || "global";
  const tasaGuardada = localStorage.getItem("tasa_bcv_user_" + usuario);
  const inputTasa = document.getElementById('facTasaBCV');
  if (inputTasa) {
    inputTasa.value = tasaGuardada ? tasaGuardada : "";
  }

  document.getElementById('facCedulaBuscar').value = "";
  document.getElementById('boxClienteEncontrado').classList.add('hidden');
  document.getElementById('boxClienteNuevo').classList.add('hidden');
  clienteFacturaActual = null;

  renderizarTablaModalFactura();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).show();
  actualizarCalculosBCV();
}

// Búsqueda de Cliente vía POST a Google Apps Script
async function buscarClienteFactura() {
  const cedula = document.getElementById('facCedulaBuscar').value.trim();
  if (!cedula) {
    return mostrarAvisoFactura("Ingrese la Cédula o RIF.");
  }

  const btn = document.getElementById('btnBuscarClienteFac');
  btn.disabled = true;
  btn.textContent = "Buscando...";

  try {
    const response = await fetch(API_URL_GAS, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "buscarCliente",
        cedula: cedula
      })
    });

    const res = await response.json();
    btn.disabled = false;
    btn.textContent = "🔍 Buscar";

    const boxEncontrado = document.getElementById('boxClienteEncontrado');
    const boxNuevo = document.getElementById('boxClienteNuevo');

    if (res.status === "success") {
      clienteFacturaActual = res.cliente;

      document.getElementById('facClienteCedulaRead').value = res.cliente.cedula;
      document.getElementById('facClienteNombreRead').value = res.cliente.nombre;
      document.getElementById('facClienteTelefonoRead').value = res.cliente.telefono || "N/D";
      document.getElementById('facClienteDireccionRead').value = res.cliente.direccion || "N/D";

      boxEncontrado.classList.remove('hidden');
      boxNuevo.classList.add('hidden');
      mostrarAvisoFactura("Cliente localizado con éxito.");

    } else if (res.status === "not_found") {
      clienteFacturaActual = null;

      document.getElementById('facRegCedula').value = cedula.toUpperCase();
      document.getElementById('facRegNombre').value = "";
      document.getElementById('facRegTelefono').value = "";
      document.getElementById('facRegDireccion').value = "";

      boxEncontrado.classList.add('hidden');
      boxNuevo.classList.remove('hidden');
      mostrarAvisoFactura("Cliente no registrado. Complete los datos para crearlo.");

    } else {
      mostrarAvisoFactura(res.message || "Error al consultar cliente.");
    }

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "🔍 Buscar";
    console.error("Error buscar cliente:", err);
    mostrarAvisoFactura("Error de conexión al consultar cliente.");
  }
}

// Registro de Cliente Nuevo vía POST a Google Apps Script
async function registrarClienteFactura() {
  const cedula = document.getElementById('facRegCedula').value.trim();
  const nombre = document.getElementById('facRegNombre').value.trim();
  const telefono = document.getElementById('facRegTelefono').value.trim();
  const direccion = document.getElementById('facRegDireccion').value.trim();

  if (!cedula || !nombre) {
    return mostrarAvisoFactura("Cédula y Nombre son obligatorios.");
  }

  const btn = document.getElementById('btnRegistrarClienteFac');
  btn.disabled = true;
  btn.textContent = "Registrando...";

  try {
    const response = await fetch(API_URL_GAS, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "registrarClienteFactura",
        cedula: cedula,
        nombre: nombre,
        telefono: telefono,
        direccion: direccion
      })
    });

    const res = await response.json();
    btn.disabled = false;
    btn.textContent = "💾 Registrar Nuevo Cliente";

    if (res.status === "success") {
      clienteFacturaActual = res.cliente;

      document.getElementById('facClienteCedulaRead').value = res.cliente.cedula;
      document.getElementById('facClienteNombreRead').value = res.cliente.nombre;
      document.getElementById('facClienteTelefonoRead').value = res.cliente.telefono || "N/D";
      document.getElementById('facClienteDireccionRead').value = res.cliente.direccion || "N/D";

      document.getElementById('boxClienteNuevo').classList.add('hidden');
      document.getElementById('boxClienteEncontrado').classList.remove('hidden');
      mostrarAvisoFactura("Cliente registrado exitosamente.");

    } else {
      mostrarAvisoFactura(res.message || "No se pudo registrar el cliente.");
    }

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "💾 Registrar Nuevo Cliente";
    console.error("Error registrar cliente:", err);
    mostrarAvisoFactura("Error de conexión al registrar cliente.");
  }
}

// EVALUAR SI SE SELECCIONA PAGO MIXTO O COMBINACIÓN CASHEA
function evaluarFormaPagoFactura(valor) {
  const contMixto = document.getElementById('contenedorPagoMixto');
  const btnAgregar = document.getElementById('btnAgregarLineaMixto');
  const lista = document.getElementById('listaFilasPagoMixto');

  if (!contMixto) return;

  if (!valor) {
    contMixto.classList.add('hidden');
    return;
  }

  const esCasheaCombinado = valor.startsWith("Cashea + ");

  if (valor === 'Pago Mixto' || esCasheaCombinado) {
    contMixto.classList.remove('hidden');
    if (lista) lista.innerHTML = "";

    if (esCasheaCombinado) {
      if (btnAgregar) btnAgregar.classList.add('hidden');
      let segundoMetodo = valor.replace("Cashea + ", "").trim();
      agregarLineaPagoMixtoFija("Cashea", false);
      agregarLineaPagoMixtoFija(segundoMetodo, false);
    } else {
      if (btnAgregar) btnAgregar.classList.remove('hidden');
      agregarLineaPagoMixto();
      agregarLineaPagoMixto();
    }

    calcularTotalPagoMixto();
  } else {
    contMixto.classList.add('hidden');
  }
}

// ACTUALIZAR PREFIJO $ / Bs SEGÚN EL MÉTODO DE PAGO ELEGIDO
function actualizarPrefijoFilaMixta(selectElem) {
  const fila = selectElem.closest('.fila-pago-mixto');
  if (!fila) return;
  const prefijoSpan = fila.querySelector('.simbolo-moneda-mixto');
  if (!prefijoSpan) return;

  const metodo = selectElem.value;
  if (METODOS_BS.includes(metodo)) {
    prefijoSpan.textContent = "Bs";
    prefijoSpan.className = "input-group-text border-dark simbolo-moneda-mixto bg-warning text-dark fw-bold";
  } else {
    prefijoSpan.textContent = "$";
    prefijoSpan.className = "input-group-text border-dark simbolo-moneda-mixto bg-light text-dark fw-bold";
  }
}

// AGREGAR FILA PAGO MIXTO FIJA (PARA CASHEA)
function agregarLineaPagoMixtoFija(metodoPredeterminado, esEliminable = true) {
  const lista = document.getElementById('listaFilasPagoMixto');
  if (!lista) return;

  const divFila = document.createElement('div');
  divFila.className = 'row g-2 mb-2 align-items-center fila-pago-mixto';

  const opciones = [
    "Cashea", "Efectivo Divisas", "Efectivo Bolívares", "Pago Móvil", 
    "Zelle", "PayPal", "Punto de Venta", "Transferencia Bancaria"
  ];

  let selectOptions = opciones.map(opt => {
    let sel = (opt.toLowerCase() === metodoPredeterminado.toLowerCase()) ? 'selected' : '';
    return `<option value="${opt}" ${sel}>${opt}</option>`;
  }).join('');

  let disabledAttr = !esEliminable ? 'disabled' : '';
  let botonAccion = esEliminable 
    ? `<button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 border-0 fw-bold" onclick="eliminarLineaPagoMixto(this)">✕</button>`
    : `<button type="button" class="btn btn-sm btn-light py-0 px-2 border-0 fw-bold text-muted" disabled>🔒</button>`;

  let esBs = METODOS_BS.includes(metodoPredeterminado);
  let prefijoTxt = esBs ? "Bs" : "$";
  let prefijoClass = esBs ? "bg-warning text-dark fw-bold" : "bg-light text-dark fw-bold";

  divFila.innerHTML = `
    <div class="col-6">
      <select class="form-select form-select-sm border-dark select-metodo-mixto" onchange="actualizarPrefijoFilaMixta(this); calcularTotalPagoMixto();" ${disabledAttr}>
        ${selectOptions}
      </select>
    </div>
    <div class="col-4">
      <div class="input-group input-group-sm">
        <span class="input-group-text border-dark simbolo-moneda-mixto ${prefijoClass}">${prefijoTxt}</span>
        <input type="number" class="form-control border-dark input-monto-mixto" step="0.01" min="0" placeholder="0.00" oninput="calcularTotalPagoMixto()">
      </div>
    </div>
    <div class="col-2 text-end">
      ${botonAccion}
    </div>
  `;

  lista.appendChild(divFila);
}

// AGREGAR FILA PAGO MIXTO EDITABLE
function agregarLineaPagoMixto() {
  const lista = document.getElementById('listaFilasPagoMixto');
  if (!lista) return;
  
  const divFila = document.createElement('div');
  divFila.className = 'row g-2 mb-2 align-items-center fila-pago-mixto';

  divFila.innerHTML = `
    <div class="col-6">
      <select class="form-select form-select-sm border-dark select-metodo-mixto" onchange="actualizarPrefijoFilaMixta(this); calcularTotalPagoMixto();">
        <option value="" disabled selected>-- Método --</option>
        <option value="Efectivo Divisas">Efectivo Divisas</option>
        <option value="Efectivo Bolívares">Efectivo Bolívares</option>
        <option value="Pago Móvil">Pago Móvil</option>
        <option value="Zelle">Zelle</option>
        <option value="PayPal">PayPal</option>
        <option value="Cashea">Cashea</option>
        <option value="Punto de Venta">Punto de Venta</option>
        <option value="Transferencia Bancaria">Transferencia Bancaria</option>
      </select>
    </div>
    <div class="col-4">
      <div class="input-group input-group-sm">
        <span class="input-group-text border-dark simbolo-moneda-mixto bg-light fw-bold">$</span>
        <input type="number" class="form-control border-dark input-monto-mixto" step="0.01" min="0" placeholder="0.00" oninput="calcularTotalPagoMixto()">
      </div>
    </div>
    <div class="col-2 text-end">
      <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 border-0 fw-bold" onclick="eliminarLineaPagoMixto(this)">✕</button>
    </div>
  `;

  lista.appendChild(divFila);
  calcularTotalPagoMixto();
}

// ELIMINAR FILA DE PAGO MIXTO
function eliminarLineaPagoMixto(btn) {
  const lista = document.getElementById('listaFilasPagoMixto');
  if (lista && lista.children.length <= 1) {
    return mostrarAvisoFactura("El Pago Mixto requiere al menos una forma de pago.");
  }
  btn.closest('.fila-pago-mixto').remove();
  calcularTotalPagoMixto();
}

// CALCULAR Y VALIDAR TOTALES EN PAGO MIXTO
function calcularTotalPagoMixto() {
  const tasa = obtenerTasaBCV();
  let sumaAsignadaUSD = 0;
  let sumaAsignadaBs = 0;

  const filas = document.querySelectorAll('.fila-pago-mixto');
  filas.forEach(f => {
    let selectMetodo = f.querySelector('.select-metodo-mixto');
    let inputMonto = f.querySelector('.input-monto-mixto');

    if (selectMetodo && inputMonto) {
      let metodo = selectMetodo.value;
      let montoTipado = parseFloat(inputMonto.value) || 0;

      if (METODOS_BS.includes(metodo)) {
        sumaAsignadaBs += montoTipado;
        sumaAsignadaUSD += tasa > 0 ? (montoTipado / tasa) : 0;
      } else {
        sumaAsignadaUSD += montoTipado;
        sumaAsignadaBs += montoTipado * tasa;
      }
    }
  });

  let totalFacturaUSD = 0;
  for (let key in itemsFactura) {
    totalFacturaUSD += parseFloat(itemsFactura[key].precioTotal) || 0;
  }
  let totalFacturaBs = totalFacturaUSD * tasa;

  let restanteUSD = totalFacturaUSD - sumaAsignadaUSD;
  let restanteBs = totalFacturaBs - sumaAsignadaBs;

  if (Math.abs(restanteUSD) < 0.001) restanteUSD = 0;
  if (Math.abs(restanteBs) < 0.01) restanteBs = 0;

  const elemAsignado = document.getElementById('montoAsignadoMixto');
  const elemEsperado = document.getElementById('montoEsperadoMixto');
  const elemRestante = document.getElementById('montoRestanteMixto');

  if (monedaVistaModal === "BS") {
    if (elemAsignado) elemAsignado.textContent = `Bs. ${sumaAsignadaBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elemEsperado) elemEsperado.textContent = `Bs. ${totalFacturaBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (elemRestante) {
      elemRestante.textContent = `Bs. ${restanteBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (restanteBs === 0) {
        elemRestante.className = 'text-success fw-bold';
      } else if (restanteBs > 0) {
        elemRestante.className = 'text-warning fw-bold';
      } else {
        elemRestante.className = 'text-danger fw-bold';
      }
    }

    if (elemAsignado) {
      if (Math.abs(sumaAsignadaBs - totalFacturaBs) < 0.01) {
        elemAsignado.className = 'text-success fw-bold';
      } else {
        elemAsignado.className = 'text-primary fw-bold';
      }
    }

  } else {
    if (elemAsignado) elemAsignado.textContent = `$${sumaAsignadaUSD.toFixed(2)}`;
    if (elemEsperado) elemEsperado.textContent = `$${totalFacturaUSD.toFixed(2)}`;

    if (elemRestante) {
      elemRestante.textContent = `$${restanteUSD.toFixed(2)}`;
      if (restanteUSD === 0) {
        elemRestante.className = 'text-success fw-bold';
      } else if (restanteUSD > 0) {
        elemRestante.className = 'text-warning fw-bold';
      } else {
        elemRestante.className = 'text-danger fw-bold';
      }
    }

    if (elemAsignado) {
      if (Math.abs(sumaAsignadaUSD - totalFacturaUSD) < 0.01) {
        elemAsignado.className = 'text-success fw-bold';
      } else {
        elemAsignado.className = 'text-primary fw-bold';
      }
    }
  }

  return { 
    sumaUSD: sumaAsignadaUSD, 
    totalUSD: totalFacturaUSD, 
    restanteUSD: restanteUSD,
    sumaBs: sumaAsignadaBs,
    totalBs: totalFacturaBs,
    restanteBs: restanteBs
  };
}

// RESOLVER CADENA FINAL DEL PAGO PARA EMISIÓN
function obtenerDetalleFormaPagoFinal() {
  const formaSelect = document.getElementById('facFormaPagoSelect').value;
  if (!formaSelect) return null;

  const esCasheaCombinado = formaSelect.startsWith("Cashea + ");

  if (formaSelect === 'Pago Mixto' || esCasheaCombinado) {
    const tasa = obtenerTasaBCV();
    if (tasa <= 0) {
      mostrarAvisoFactura("Indique una Tasa BCV válida antes de procesar un pago en Bolívares o Mixto.");
      return null;
    }

    const filas = document.querySelectorAll('.fila-pago-mixto');
    let desglose = [];
    let valido = true;

    filas.forEach(f => {
      let metodo = f.querySelector('.select-metodo-mixto').value;
      let montoTipado = parseFloat(f.querySelector('.input-monto-mixto').value) || 0;

      if (!metodo || montoTipado <= 0) {
        valido = false;
      } else {
        if (METODOS_BS.includes(metodo)) {
          let eqUSD = montoTipado / tasa;
          desglose.push(`${metodo}: Bs. ${montoTipado.toLocaleString('es-VE', { minimumFractionDigits: 2 })} (~$${eqUSD.toFixed(2)})`);
        } else {
          let eqBs = montoTipado * tasa;
          desglose.push(`${metodo}: $${montoTipado.toFixed(2)} (~Bs. ${eqBs.toLocaleString('es-VE', { minimumFractionDigits: 2 })})`);
        }
      }
    });

    if (!valido) {
      mostrarAvisoFactura("Indique un monto mayor a cero en cada renglón de pago.");
      return null;
    }

    const calc = calcularTotalPagoMixto();
    if (Math.abs(calc.restanteUSD) >= 0.02) {
      mostrarAvisoFactura(`La suma asignada debe cubrir el total de la factura. Restante: $${Math.abs(calc.restanteUSD).toFixed(2)}.`);
      return null;
    }

    return `${formaSelect} (${desglose.join(' + ')})`;
  }

  return formaSelect;
}

// EMITIR FACTURA FINAL
async function emitirFacturaFinal() {
  if (!clienteFacturaActual) {
    return mostrarAvisoFactura("Debe buscar o registrar un cliente antes de emitir.");
  }

  const formaPagoStr = obtenerDetalleFormaPagoFinal();
  if (!formaPagoStr) return;

  const btn = document.getElementById('btnEmitirFacturaFinal');
  btn.disabled = true;
  btn.textContent = "Generando Ticket...";

  try {
    // 1. Obtener el número correlativo desde Google Apps Script
    const response = await fetch(API_URL_GAS, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "obtenerCorrelativoFactura" })
    });

    const res = await response.json();
    btn.disabled = false;
    btn.textContent = "🧾 Emitir Factura";

    let numFactura = res.facturaNum || "001-00001";

    // 2. Construir el objeto con los datos completos
    const tasa = obtenerTasaBCV();
    let totalUSD = 0;
    let productosSummaryList = [];

    for (let key in itemsFactura) {
      let item = itemsFactura[key];
      totalUSD += parseFloat(item.precioTotal) || 0;
      productosSummaryList.push(`${key} (${item.cantidadTxt}) - $${item.precioTotal}`);
    }

    let totalBs = totalUSD * tasa;

    datosFacturaPendiente = {
      numFactura: numFactura,
      fechaStr: new Date().toLocaleString('es-VE'),
      cliente: clienteFacturaActual,
      formaPagoStr: formaPagoStr,
      desglosePagos: obtenerObjetoDesgloseMetodos(),
      totalUSD: totalUSD,
      totalBs: totalBs,
      tasaBCV: tasa,
      monedaVistaModal: monedaVistaModal, // Transfiere la moneda seleccionada (USD o BS)
      productosSummary: productosSummaryList.join(' | ')
    };

    // 3. Renderizar la maquetación exacta del Ticket Térmico de 72mm
    renderizarTicketTermicoHTML(datosFacturaPendiente);

    // 4. Desplegar el Modal de Vista Previa (Sin abrir pop-ups)
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalVistaPreviaFactura')).show();

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "🧾 Emitir Factura";
    console.error("Error al obtener correlativo:", err);
    mostrarAvisoFactura("Error de conexión al obtener correlativo de factura.");
  }
}

// RENDERIZAR LA ESTRUCTURA DEL TICKET TÉRMICO (XP-80C 72mm)
function renderizarTicketTermicoHTML(d) {
  let filasProductosHtml = "";
  let i = 1;
  let esModoBs = (d.monedaVistaModal === "BS");
  let tasa = d.tasaBCV || 1;

  for (let key in itemsFactura) {
    let item = itemsFactura[key];
    let precUnit = "";
    let itemTotalTxt = "";

    if (esModoBs) {
      let precBaseBs = (parseFloat(item.precioBase) || 0) * tasa;
      let precTotalBs = (parseFloat(item.precioTotal) || 0) * tasa;
      let unidadBs = (item.unidad === 'gramos' || item.unidad === 'mixto') ? '/Kg' : '/Ud';

      precUnit = `Bs. ${precBaseBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unidadBs}`;
      itemTotalTxt = `Bs. ${precTotalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
      let unidadUsd = (item.unidad === 'gramos' || item.unidad === 'mixto') ? '/Kg' : '/Ud';

      precUnit = `$${item.precioBase.toFixed(2)}${unidadUsd}`;
      itemTotalTxt = `$${item.precioTotal}`;
    }

    filasProductosHtml += `
      <tr>
        <td style="width:6%;">${i++}</td>
        <td style="width:38%;" class="fw-bold">${key}</td>
        <td style="width:24%;" class="text-center">${precUnit}</td>
        <td style="width:14%;" class="text-center">${item.cantidadTxt}</td>
        <td style="width:18%;" class="text-end fw-bold">${itemTotalTxt}</td>
      </tr>`;
  }

  // Totales dinámicos según la moneda activa
  let bloqueTotalesHtml = "";
  if (esModoBs) {
    bloqueTotalesHtml = `
      <div class="d-flex justify-content-between">
        <span>TOTAL FACTURA (Bs):</span>
        <strong class="fs-6">Bs. ${d.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
      </div>
      <div class="d-flex justify-content-between text-muted">
        <span>TOTAL FACTURA ($):</span>
        <span>$${d.totalUSD.toFixed(2)}</span>
      </div>`;
  } else {
    bloqueTotalesHtml = `
      <div class="d-flex justify-content-between">
        <span>TOTAL FACTURA ($):</span>
        <strong class="fs-6">$${d.totalUSD.toFixed(2)}</strong>
      </div>
      <div class="d-flex justify-content-between text-muted">
        <span>TOTAL FACTURA (Bs):</span>
        <span>Bs. ${d.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>`;
  }

  const ticketHtml = `
    <div class="ticket-container shadow-sm border">
      <div class="ticket-header">
        <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
        <div>RIF: J-505072889 | TELF: 0412-1753275</div>
        <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
        <div>HORARIO: 7:30am - 19:00pm</div>
      </div>

      <div class="ticket-info">
        <div><strong>FACTURA N°:</strong> <span class="fs-6">${d.numFactura}</span></div>
        <div><strong>FECHA:</strong> ${d.fechaStr}</div>
        <div><strong>CLIENTE:</strong> ${d.cliente.nombre}</div>
        <div><strong>CI/RIF:</strong> ${d.cliente.cedula} | <strong>TELF:</strong> ${d.cliente.telefono || 'N/D'}</div>
        <div><strong>DIR:</strong> ${d.cliente.direccion || 'N/D'}</div>
      </div>

      <table class="ticket-table">
        <thead>
          <tr>
            <th>#</th>
            <th>PRODUCTO</th>
            <th class="text-center">PRECIO</th>
            <th class="text-center">CANT/PESO</th>
            <th class="text-end">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          ${filasProductosHtml}
        </tbody>
      </table>

      <div class="ticket-totals border-top pt-1">
        ${bloqueTotalesHtml}
        <div class="ticket-divider"></div>
        <div><strong>FORMA DE PAGO:</strong></div>
        <div class="small">${d.formaPagoStr}</div>
      </div>

      <div class="ticket-footer">
        <div>¡Gracias por su preferencia!</div>
      </div>
    </div>
  `;

  // Renderizar tanto en el contenedor de impresión como en la vista previa del modal
  const elemImpresion = document.getElementById('contenidoTicketImprimible');
  const elemModal = document.getElementById('vistaPreviaTicketModal');

  if (elemImpresion) elemImpresion.innerHTML = ticketHtml;
  if (elemModal) elemModal.innerHTML = ticketHtml;
}

// OBTENER OBJETO CON MONTO POR CADA MÉTODO
function obtenerObjetoDesgloseMetodos() {
  const formaSelect = document.getElementById('facFormaPagoSelect').value;
  let desgl = {
    "Efectivo Divisas": 0,
    "Efectivo Bolívares": 0,
    "Pago Móvil": 0,
    "Zelle": 0,
    "PayPal": 0,
    "Cashea": 0,
    "Punto de Venta": 0,
    "Transferencia Bancaria": 0
  };

  let totalUSD = 0;
  for (let key in itemsFactura) {
    totalUSD += parseFloat(itemsFactura[key].precioTotal) || 0;
  }

  const esCasheaCombinado = formaSelect.startsWith("Cashea + ");

  if (formaSelect === 'Pago Mixto' || esCasheaCombinado) {
    const tasa = obtenerTasaBCV();
    const filas = document.querySelectorAll('.fila-pago-mixto');

    filas.forEach(f => {
      let metodo = f.querySelector('.select-metodo-mixto').value;
      let montoTipado = parseFloat(f.querySelector('.input-monto-mixto').value) || 0;

      if (metodo && montoTipado > 0) {
        if (METODOS_BS.includes(metodo)) {
          let eqUSD = tasa > 0 ? (montoTipado / tasa) : 0;
          desgl[metodo] = (desgl[metodo] || 0) + eqUSD;
        } else {
          desgl[metodo] = (desgl[metodo] || 0) + montoTipado;
        }
      }
    });
  } else {
    desgl[formaSelect] = totalUSD;
  }

  return desgl;
}

// CONFIRMAR, GUARDAR EN HOJA E IMPRIMIR EN TÉRMICA XP-80C
async function confirmarEImprimirFactura() {
  if (!datosFacturaPendiente) return;

  const btn = document.getElementById('btnConfirmarEmisionFinal');
  btn.disabled = true;
  btn.textContent = "Procesando e Imprimiendo...";

  try {
    const response = await fetch(API_URL_GAS, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "guardarFacturaFinal",
        datosFactura: {
          cedula: datosFacturaPendiente.cliente.cedula,
          nombre: datosFacturaPendiente.cliente.nombre,
          direccion: datosFacturaPendiente.cliente.direccion || 'N/D',
          productosSummary: datosFacturaPendiente.productosSummary,
          formaPago: datosFacturaPendiente.formaPagoStr,
          montoTotal: datosFacturaPendiente.totalUSD,
          desglosePagos: datosFacturaPendiente.desglosePagos
        }
      })
    });

    const res = await response.json();
    btn.disabled = false;
    btn.textContent = "🖨️ Confirmar y Facturar";

    if (res.status === "success") {
      // 1. Invocación de la orden de impresión térmica
      window.print();

      // 2. Resetear la interfaz del módulo
      itemsFactura = {};
      clienteFacturaActual = null;
      datosFacturaPendiente = null;
      renderizarResumenFactura();

      // 3. Cerrar modales
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalVistaPreviaFactura')).hide();
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();

      mostrarAvisoFactura(`Factura ${res.facturaNum} emitida y guardada con éxito 🎉`);

    } else {
      mostrarAvisoFactura(res.message || res.error || "Error al guardar la factura en la base de datos.");
    }

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "🖨️ Confirmar y Facturar";
    console.error("Error al guardar factura:", err);
    mostrarAvisoFactura("Error de conexión al registrar la venta.");
  }
}

// Control Navegación: Retroceder
function retrocederProcesoFactura() {
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();
}

// Control Navegación: Cancelar
function cancelarProcesoFactura() {
  if (confirm("¿Está seguro de cancelar el proceso? Se limpiará toda la selección actual.")) {
    itemsFactura = {};
    clienteFacturaActual = null;
    renderizarResumenFactura();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();
    mostrarAvisoFactura("Proceso cancelado. Selección reiniciada.");
  }
}

// Autenticación Persistente en Sesión
document.addEventListener("DOMContentLoaded", function() {
  const token = sessionStorage.getItem("factura_token");
  const usuario = sessionStorage.getItem("factura_usuario");

  if (token && usuario) {
    iniciarModuloFacturacion(usuario);
  }
});
