/* ==========================================================================
   Lógica del Módulo de Facturación No Fiscal - Mundocarnes
   ========================================================================== */

// URL de la API de Google Apps Script
const API_URL_GAS = "https://script.google.com/macros/s/AKfycbwioDKH4HuEZoaZfw5YvbmPI4450jipV4oNBVcZcqtCciRWCM3-s8T98pU9vS9VjSbz/exec";

let itemsFactura = {};
let productoTemporalFactura = {};
let cacheCategoriasFactura = [];
let clienteFacturaActual = null;

// Notificaciones Toast
function mostrarAvisoFactura(mensaje) {
  try {
    document.getElementById('toastMensajeFactura').textContent = mensaje;
    bootstrap.Toast.getOrCreateInstance(document.getElementById('toastFactura')).show();
  } catch (e) {
    alert(mensaje);
  }
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

    if (prod.unidad === 'mixto') {
      let totalGramos = cant * (prod.pesoPromedio || 0);
      calc = (prod.precio / 1000) * totalGramos;
      let kg = Math.floor(totalGramos / 1000);
      let g = totalGramos % 1000;
      let pesoTxt = kg > 0 ? (g > 0 ? `${kg}Kg ${g}g` : `${kg}Kg`) : `${g}g`;
      cantTxt = `${cant} uds (~${pesoTxt})`;
    } else {
      calc = prod.precio * cant;
    }

    itemsFactura[prod.nombre] = {
      cantidadTxt: cantTxt,
      cantNumerica: cant,
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
  document.getElementById('facFormaPagoSelect').value = "";
  document.getElementById('contenedorPagoMixto').classList.add('hidden');
  document.getElementById('listaFilasPagoMixto').innerHTML = "";
  if (Object.keys(itemsFactura).length === 0) {
    return mostrarAvisoFactura("Seleccione al menos un producto para facturar.");
  }

  // 1. Renderizar la Tabla Resumen de Productos dentro del Modal
  let htmlTabla = "";
  let totalAcumulado = 0;

  for (let key in itemsFactura) {
    let item = itemsFactura[key];
    totalAcumulado += parseFloat(item.precioTotal);

    let precioUnitarioTxt = (item.unidad === 'gramos' || item.unidad === 'mixto')
      ? `$${item.precioBase.toFixed(2)} / Kg`
      : `$${item.precioBase.toFixed(2)} / Ud`;

    let imgRuta = item.imgPath || '../img/LOGO-MUNDO123.webp';

    htmlTabla += `
      <tr>
        <td class="text-center">
          <img src="${imgRuta}" class="img-thumb-factura" alt="${key}">
        </td>
        <td class="fw-bold">${key}</td>
        <td class="text-center">${precioUnitarioTxt}</td>
        <td class="text-center fw-bold">${item.cantidadTxt}</td>
        <td class="text-end fw-bold text-success">$${item.precioTotal}</td>
      </tr>`;
  }

  document.getElementById('tablaModalResumenProductos').innerHTML = htmlTabla;
  document.getElementById('montoModalTotalFactura').textContent = `$${totalAcumulado.toFixed(2)}`;

  // 2. Limpiar campos de búsqueda de cliente
  document.getElementById('facCedulaBuscar').value = "";
  document.getElementById('boxClienteEncontrado').classList.add('hidden');
  document.getElementById('boxClienteNuevo').classList.add('hidden');
  document.getElementById('facFormaPagoSelect').value = "";
  clienteFacturaActual = null;

  // 3. Desplegar Modal en el DOM (Sin pop-ups)
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).show();
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

// Control Navegación: Retroceder (Cierra modal y conserva los productos)
function retrocederProcesoFactura() {
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();
}

// Control Navegación: Cancelar (Limpia selección completa y regresa a cero)
function cancelarProcesoFactura() {
  if (confirm("¿Está seguro de cancelar el proceso? Se limpiará toda la selección actual.")) {
    itemsFactura = {};
    clienteFacturaActual = null;
    renderizarResumenFactura();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();
    mostrarAvisoFactura("Proceso cancelado. Selección reiniciada.");
  }
}

// Preparado para la Fase 3
function emitirFacturaFinal() {
  if (!clienteFacturaActual) {
    return mostrarAvisoFactura("Debe buscar o registrar un cliente antes de emitir.");
  }

  const formaPagoStr = obtenerDetalleFormaPagoFinal();
  if (!formaPagoStr) return; // Si retorna null, ya mostró la alerta correspondiente

  console.log("=== DATOS CAPTURADOS PARA EMISIÓN ===");
  console.log("Cliente:", clienteFacturaActual);
  console.log("Forma de Pago Resuelta:", formaPagoStr);
  console.log("Productos:", itemsFactura);

  mostrarAvisoFactura("Pago validado correctamente. Listo para Fase 3.");
}

// Autenticación Persistente en Sesión
document.addEventListener("DOMContentLoaded", function() {
  const token = sessionStorage.getItem("factura_token");
  const usuario = sessionStorage.getItem("factura_usuario");

  if (token && usuario) {
    iniciarModuloFacturacion(usuario);
  }
});

// EVALUAR SI SE SELECCIONA PAGO MIXTO
function evaluarFormaPagoFactura(valor) {
  const contMixto = document.getElementById('contenedorPagoMixto');
  if (valor === 'Pago Mixto') {
    contMixto.classList.remove('hidden');
    const lista = document.getElementById('listaFilasPagoMixto');
    if (lista.children.length === 0) {
      agregarLineaPagoMixto(); // Primera línea por defecto
      agregarLineaPagoMixto(); // Segunda línea por defecto
    }
    calcularTotalPagoMixto();
  } else {
    contMixto.classList.add('hidden');
  }
}

// AGREGAR UNA NUEVA FILA A PAGO MIXTO
function agregarLineaPagoMixto() {
  const lista = document.getElementById('listaFilasPagoMixto');
  
  const divFila = document.createElement('div');
  divFila.className = 'row g-2 mb-2 align-items-center fila-pago-mixto';

  divFila.innerHTML = `
    <div class="col-6">
      <select class="form-select form-select-sm border-dark select-metodo-mixto" onchange="calcularTotalPagoMixto()">
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
        <span class="input-group-text border-dark">$</span>
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
  if (lista.children.length <= 1) {
    return mostrarAvisoFactura("El Pago Mixto requiere al menos una forma de pago.");
  }
  btn.closest('.fila-pago-mixto').remove();
  calcularTotalPagoMixto();
}

// CALCULAR Y VALIDAR TOTALES EN PAGO MIXTO
function calcularTotalPagoMixto() {
  let suma = 0;
  const montos = document.querySelectorAll('.input-monto-mixto');
  montos.forEach(inp => {
    let v = parseFloat(inp.value) || 0;
    suma += v;
  });

  // Obtener el Total General de la Factura desde el modal
  let totalFacturaTxt = document.getElementById('montoModalTotalFactura').textContent.replace('$', '').trim();
  let totalFactura = parseFloat(totalFacturaTxt) || 0;

  document.getElementById('montoAsignadoMixto').textContent = `$${suma.toFixed(2)}`;
  document.getElementById('montoEsperadoMixto').textContent = `$${totalFactura.toFixed(2)}`;

  if (Math.abs(suma - totalFactura) < 0.01) {
    document.getElementById('montoAsignadoMixto').className = 'text-success fw-bold';
  } else {
    document.getElementById('montoAsignadoMixto').className = 'text-primary fw-bold';
  }

  return { suma: suma, totalFactura: totalFactura };
}

// OBTENER LA FORMA DE PAGO SELECCIONADA
function obtenerDetalleFormaPagoFinal() {
  const formaSelect = document.getElementById('facFormaPagoSelect').value;
  if (!formaSelect) return null;

  if (formaSelect === 'Pago Mixto') {
    const filas = document.querySelectorAll('.fila-pago-mixto');
    let desglose = [];
    let valido = true;

    filas.forEach(f => {
      let metodo = f.querySelector('.select-metodo-mixto').value;
      let monto = parseFloat(f.querySelector('.input-monto-mixto').value) || 0;

      if (!metodo || monto <= 0) {
        valido = false;
      } else {
        desglose.push(`${metodo}: $${monto.toFixed(2)}`);
      }
    });

    if (!valido) {
      mostrarAvisoFactura("Indique método y monto válido en cada renglón del Pago Mixto.");
      return null;
    }

    const calc = calcularTotalPagoMixto();
    if (Math.abs(calc.suma - calc.totalFactura) >= 0.01) {
      mostrarAvisoFactura(`La suma del Pago Mixto ($${calc.suma.toFixed(2)}) debe coincidir con el Total ($${calc.totalFactura.toFixed(2)}).`);
      return null;
    }

    return `Pago Mixto (${desglose.join(' + ')})`;
  }

  return formaSelect;
}
