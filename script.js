/* ==========================================================================
   Lógica del Frontend e Interacción Optimizada - Mundocarnes
   ========================================================================== */

const API_URL = "https://script.google.com/macros/s/AKfycbwioDKH4HuEZoaZfw5YvbmPI4450jipV4oNBVcZcqtCciRWCM3-s8T98pU9vS9VjSbz/exec";

// Función de comunicación REST asíncrona optimizada
async function callAPI(action, data = {}) {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      mode: "cors",
      headers: {
        "Content-Type": "text/plain"
      },
      body: JSON.stringify({ action, ...data })
    });
    return await response.json();
  } catch (error) {
    console.error("Error en conexión REST:", error);
    return { error: "Ocurrió un retardo de conexión. Por favor intente de nuevo." };
  }
}

let carrito = {}, productoTemporal = {}, cacheUsuario = { cedula: "", nombre: "", apellido: "", telefono: "", rol: "" }, datosCheckout = { ubicacion: "", formaPago: "" };
let cacheCategorias = []; 
let iti; 

document.addEventListener("DOMContentLoaded", function() {
  const inputTelefono = document.querySelector("#regTelefono");
  if (inputTelefono) {
    iti = window.intlTelInput(inputTelefono, {
      initialCountry: "ve", 
      separateDialCode: true,
      utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js"
    });
  }
});

function mostrarAviso(mensaje) {
  try { 
    document.getElementById('toastMensaje').textContent = mensaje; 
    new bootstrap.Toast(document.getElementById('liveToast')).show();
  } catch(e) { 
    alert(mensaje); 
  }
}

function regresarAlInicio() {
  cacheUsuario = { cedula: "", nombre: "", apellido: "", telefono: "", rol: "" }; carrito = {}; cacheCategorias = [];
  document.getElementById('cedula').value = ""; document.getElementById('passwordAdmin').value = "";
  document.getElementById('regNombre').value = ""; document.getElementById('regApellido').value = "";
  if (iti) {
    iti.setNumber(""); 
  } else {
    document.getElementById('regTelefono').value = "";
  }
  document.getElementById('vistaAdminPassword').classList.add('hidden'); document.getElementById('vistaRegistro').classList.add('hidden');
  document.getElementById('vistaCombos').classList.add('hidden'); document.getElementById('vistaPedido').classList.add('hidden');
  document.getElementById('vistaIngreso').classList.remove('hidden');
}

function procesarPrimerPaso() {
  const cedulaInput = document.getElementById('cedula').value.trim();
  if (!cedulaInput) { mostrarAviso("Introduzca su Cédula o RIF."); return; }
  
  const btn = document.getElementById('btnSiguiente'); 
  btn.disabled = true; 
  btn.textContent = "Verificando...";
  
  callAPI("verificarUsuario", { cedula: cedulaInput }).then(function(respuesta) {
    btn.disabled = false; 
    btn.textContent = "Siguiente";
    if (!respuesta) return alert("Error crítico.");
    if (respuesta.error) return alert("Aviso: " + respuesta.error);
    
    cacheUsuario.cedula = cedulaInput;
    
    if (respuesta.status === "ADMIN") {
      cacheUsuario.nombre = respuesta.nombre; cacheUsuario.apellido = respuesta.apellido;
      document.getElementById('saludoAdmin').textContent = `Bienvenido: ${respuesta.nombre} ${respuesta.apellido}`;
      document.getElementById('vistaIngreso').classList.add('hidden'); document.getElementById('vistaAdminPassword').classList.remove('hidden');
    } else if (respuesta.status === "CLIENTE") {
      cacheUsuario.nombre = respuesta.nombre; cacheUsuario.apellido = respuesta.apellido; cacheUsuario.telefono = respuesta.telefono; cacheUsuario.rol = "CLIENTE";
      concederAccesoAlSistema();
    } else {
      document.getElementById('vistaIngreso').classList.add('hidden'); document.getElementById('vistaRegistro').classList.remove('hidden');
    }
  }).catch(function(err) {
    btn.disabled = false; 
    btn.textContent = "Siguiente";
    alert("Error de conexión temporal.");
  });
}

function verificarPasswordAdministrador() {
  const pass = document.getElementById('passwordAdmin').value.trim();
  if (!pass) return;
  const btn = document.getElementById('btnAdminIngreso'); 
  btn.disabled = true;
  btn.textContent = "Verificando...";
  
  callAPI("validarPasswordAdmin", { cedula: cacheUsuario.cedula, password: pass }).then(function(res) {
    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema";
    if (res.error) return alert(res.error);
    if (res.valido) { cacheUsuario.rol = "ADMIN"; concederAccesoAlSistema(); } else mostrarAviso("Contraseña incorrecta.");
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema";
  });
}

function ejecutarRegistroNuevoCliente() {
  const nom = document.getElementById('regNombre').value.trim(), ape = document.getElementById('regApellido').value.trim();
  
  if (!nom || !ape) return mostrarAviso("Llene todos los campos.");
  
  let tel = "";
  if (iti) {
    if (!iti.isValidNumber()) {
      return mostrarAviso("Por favor, introduzca un número de teléfono celular válido.");
    }
    tel = iti.getNumber();
  } else {
    tel = document.getElementById('regTelefono').value.trim();
    if (!tel) return mostrarAviso("Llene todos los campos.");
  }
  
  const btn = document.getElementById('btnRegistrar'); 
  btn.disabled = true; 
  btn.textContent = "Registrando...";
  
  callAPI("registrarCliente", { cedula: cacheUsuario.cedula, nombre: nom, apellido: ape, telefono: tel }).then(function(res) {
    btn.disabled = false; 
    btn.textContent = "Registrar y Comprar";
    if (res.error) return alert(res.error);
    cacheUsuario.nombre = nom.toUpperCase(); cacheUsuario.apellido = ape.toUpperCase(); cacheUsuario.telefono = tel; cacheUsuario.rol = "CLIENTE";
    concederAccesoAlSistema();
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = "Registrar y Comprar";
  });
}

function concederAccesoAlSistema() {
  document.getElementById('vistaIngreso').classList.add('hidden'); document.getElementById('vistaAdminPassword').classList.add('hidden');
  document.getElementById('vistaRegistro').classList.add('hidden'); document.getElementById('vistaCombos').classList.remove('hidden');
  if (cacheUsuario.rol === "ADMIN") {
    document.getElementById('saludoUsuario').innerHTML = `⚙️ <strong>Modo Editor:</strong> ${cacheUsuario.nombre}`;
    document.getElementById('btnVerPedido').classList.add('hidden'); 
    document.getElementById('btnAdminPanel').classList.remove('hidden'); 
  } else {
    document.getElementById('saludoUsuario').innerHTML = `👋 Hola, <strong>${cacheUsuario.nombre}</strong>`;
    document.getElementById('btnVerPedido').classList.remove('hidden');
    document.getElementById('btnAdminPanel').classList.add('hidden'); 
  }
  
  callAPI("obtenerDatosCatalogo").then(renderizarCatalogo);
}

function renderizarCatalogo(resp) {
  if(resp.error) return alert(resp.error);
  
  cacheCategorias = resp.categorias || [];
  
  let tabsHtml = "";
  let contentHtml = "";
  
  cacheCategorias.forEach((cat, index) => {
    let activeClass = index === 0 ? "active" : "";
    let showActiveClass = index === 0 ? "show active" : "";
    let safeId = "tab-" + cat.nombre.replace(/\s+/g, '-').toLowerCase();
    
    tabsHtml += `
      <li class="nav-item">
        <button class="nav-link ${activeClass}" data-bs-toggle="tab" data-bs-target="#${safeId}" type="button">${cat.nombre}</button>
      </li>`;
    
    contentHtml += `
      <div class="tab-pane fade ${showActiveClass}" id="${safeId}">
        <div id="lista-${safeId}" class="row g-3"></div>
      </div>`;
  });
  
  document.getElementById('catalogoTabs').innerHTML = tabsHtml;
  document.getElementById('catalogoTabContent').innerHTML = contentHtml;
  
  cacheCategorias.forEach((cat) => {
    let safeId = "tab-" + cat.nombre.replace(/\s+/g, '-').toLowerCase();
    let idElemento = "lista-" + safeId;
    cargarLista(idElemento, cat.productos, cat.nombre);
  });
}

// Cargar Lista optimizado con lazy loading y decodificación asíncrona para liberar la red en la primera carga
function cargarLista(idElemento, datos, nombreCategoria) {
  document.getElementById(idElemento).innerHTML = datos.map(f => {
    let esDisp = f[3]; let cantMin = f[4]; let unidad = f[5];
    let claseImg = esDisp ? "" : "img-agotado";
    let etiquetaDisp = esDisp ? "" : `<span class="badge bg-danger position-absolute top-0 start-0 m-2">Agotado</span>`;
    let boton = "";
    
    if (cacheUsuario.rol === "ADMIN") {
      boton = `<button class="btn btn-sm btn-warning border-dark fw-bold mt-2 w-100" onclick="abrirModalEdicion('${f[0]}', '${f[1]}', '${nombreCategoria}', ${esDisp}, ${cantMin}, '${unidad}')">Configurar ⚙️</button>`;
    } else {
      if (esDisp) boton = `<button class="btn btn-sm btn-outline-dark fw-bold mt-2 w-100" onclick="seleccionarProducto('${f[0]}', '${f[1]}', '${nombreCategoria}', ${cantMin}, '${unidad}')">Seleccionar</button>`;
      else boton = `<button class="btn btn-sm btn-secondary fw-bold mt-2 w-100 border-dark" disabled>🚫 No Disponible</button>`;
    }
    
    let unidadTxt = (unidad === 'unidades') ? 'uds' : 'g';
    // Incorporación de loading="lazy" y decoding="async" para optimizar el renderizado masivo
    return `<div class="col-6 col-md-3"><div class="card h-100 p-2 position-relative">${etiquetaDisp}<img src="${f[2]}" loading="lazy" decoding="async" class="card-img-top ${claseImg}" onclick="mostrarImagenGrande('${f[2]}')"><h6 class="fw-bold mt-2 text-truncate">${f[0]}</h6><p class="text-success fw-bold mb-0">${f[1]} $</p><small class="text-muted" style="font-size:0.7rem;">Mín: ${cantMin} ${unidadTxt}</small>${boton}</div></div>`;
  }).join('');
}

function abrirModalEdicion(nom, prec, cat, disp, min, unidad) {
  productoTemporal = { nombre: nom, categoria: cat };
  document.getElementById('editProductoNombre').textContent = nom;
  document.getElementById('editProductoCategoria').textContent = cat;
  document.getElementById('editProductoPrecio').value = prec;
  document.getElementById('editProductoDisponible').value = disp ? "true" : "false";
  document.getElementById('editProductoMinimo').value = min;
  document.getElementById('editProductoUnidad').value = unidad || "unidades";
  new bootstrap.Modal(document.getElementById('modalEditarProducto')).show();
}

function guardarEdicionAdministrador() {
  const prec = document.getElementById('editProductoPrecio').value;
  const disp = document.getElementById('editProductoDisponible').value === "true";
  const min = document.getElementById('editProductoMinimo').value;
  const unidad = document.getElementById('editProductoUnidad').value;
  if (!prec || !min || !unidad) return mostrarAviso("Llene todos los campos");
  
  const modalEl = document.getElementById('modalEditarProducto');
  const btn = modalEl.querySelector(".btn-warning");
  btn.disabled = true;
  btn.textContent = "Guardando...";

  callAPI("editarConfiguracionProducto", {
    adminCedula: cacheUsuario.cedula,
    categoria: productoTemporal.categoria,
    nombreProducto: productoTemporal.nombre,
    nuevoPrecio: prec,
    disponible: disp,
    cantMinima: min,
    unidadMedida: unidad
  }).then(function(res) {
    btn.disabled = false;
    btn.textContent = "Guardar Cambios 💾";
    if (res.error) return alert(res.error);
    bootstrap.Modal.getInstance(modalEl).hide();
    mostrarAviso("Guardado correctamente");
    callAPI("obtenerDatosCatalogo").then(renderizarCatalogo);
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = "Guardar Cambios 💾";
  });
}

function seleccionarProducto(nom, prec, tipo, cantMin, unidad) {
  productoTemporal = { nombre: nom, precio: prec, tipo: tipo, minBase: cantMin, unidad: unidad };
  document.getElementById('nombreProductoModal').textContent = nom;
  document.getElementById('labelInput').textContent = unidad === 'unidades' ? "Cantidad (unidades):" : "Cantidad (gramos):";
  
  let inp = document.getElementById('inputCantidad');
  inp.min = cantMin; inp.value = cantMin;
  new bootstrap.Modal(document.getElementById('modalCantidad')).show();
}

function confirmarSeleccion() {
  let cant = parseInt(document.getElementById('inputCantidad').value);
  if (cant < productoTemporal.minBase) return mostrarAviso(`Mínimo de venta: ${productoTemporal.minBase}`);
  
  let etiquetaUnidad = productoTemporal.unidad === 'unidades' ? 'uds' : 'g';
  let calc = productoTemporal.unidad === 'unidades' ? (productoTemporal.precio * cant) : ((productoTemporal.precio / 1000) * cant);
  
  carrito[productoTemporal.nombre] = { 
    cantidad: cant + ' ' + etiquetaUnidad, 
    precio: calc.toFixed(2), 
    cantNumerica: cant, 
    tipo: productoTemporal.tipo, 
    unidad: productoTemporal.unidad,
    precioBase: productoTemporal.precio, 
    minBase: productoTemporal.minBase 
  };
  
  mostrarAviso(`Agregado: ${productoTemporal.nombre}`);
  bootstrap.Modal.getInstance(document.getElementById('modalCantidad')).hide();
}

function mostrarPedido() {
  document.getElementById('vistaCombos').classList.add('hidden'); document.getElementById('vistaPedido').classList.remove('hidden');
  let html = '<table class="table align-middle"><tbody>'; let t = 0;
  for (let p in carrito) {
    let item = carrito[p]; t += parseFloat(item.precio);
    html += `<tr><td style="max-width: 120px;" class="text-wrap">${p}</td><td><input type="number" class="form-control form-control-sm text-center fw-bold border-dark p-1" value="${item.cantNumerica}" min="${item.minBase}" style="width:70px" onchange="cambiarCantidadInline('${p}', this.value)"></td><td class="text-success text-nowrap">$${item.precio}</td><td><button class="btn btn-sm btn-danger px-2 py-1" onclick="eliminarDelCarrito('${p}')">X</button></td></tr>`;
  }
  html += `<tr class="table-active fw-bold border-dark border-top"><td colspan="2" class="text-end">TOTAL:</td><td class="text-danger">$${t.toFixed(2)}</td><td></td></tr></tbody></table>`;
  document.getElementById('listaPedido').innerHTML = Object.keys(carrito).length ? html : '<p class="text-center">Vacío</p>';
}

function cambiarCantidadInline(nombre, nuevaCant) {
  let item = carrito[nombre]; let cant = parseInt(nuevaCant);
  if (isNaN(cant) || cant < item.minBase) { mostrarAviso(`Mínimo requerido: ${item.minBase}`); mostrarPedido(); return; }
  item.cantNumerica = cant; 
  let etiquetaUnidad = item.unidad === 'unidades' ? 'uds' : 'g';
  item.cantidad = cant + ' ' + etiquetaUnidad;
  let calc = item.unidad === 'unidades' ? (item.precioBase * cant) : ((item.precioBase / 1000) * cant);
  item.precio = calc.toFixed(2);
  mostrarPedido();
}

function eliminarDelCarrito(p) { delete carrito[p]; mostrarPedido(); }
function cerrarPedido() { document.getElementById('vistaPedido').classList.add('hidden'); document.getElementById('vistaCombos').classList.remove('hidden'); }

function abrirSolicitudPago() {
  if(!Object.keys(carrito).length) return;
  new bootstrap.Modal(document.getElementById('modalSolicitudPago')).show();
}

function alternarTipoEntrega(tipo) { document.getElementById('contenedorUbicacion').classList.toggle('hidden', tipo === 'Pickup'); }

function procesarEnvioSolicitud() {
  datosCheckout.ubicacion = document.getElementById('tipoEntregaSelect').value === 'Pickup' ? 'Retiro Local' : document.getElementById('ubicacionEntrega').value;
  datosCheckout.formaPago = document.getElementById('formaPagoSelect').value;
  if (document.getElementById('tipoEntregaSelect').value === 'Delivery' && !datosCheckout.ubicacion) return mostrarAviso("Escriba la dirección");
  if (!datosCheckout.formaPago) return mostrarAviso("Seleccione pago");
  
  bootstrap.Modal.getInstance(document.getElementById('modalSolicitudPago')).hide();
  
  let total = 0;
  let listaHtml = '<ul class="list-unstyled mb-1">';
  for (let p in carrito) {
    listaHtml += `<li class="small">▫️ <strong>${p}</strong> (${carrito[p].cantidad}) — <span class="text-success">$${carrito[p].precio}</span></li>`;
    total += parseFloat(carrito[p].precio);
  }
  listaHtml += '</ul>';

  document.getElementById('cuerpoMensajeConfirmacion').innerHTML = `
    <p class="fw-bold mb-2">Por favor, verifique los detalles de su pedido:</p>
    <div class="border p-2 bg-light rounded mb-3" style="max-height: 150px; overflow-y: auto;">
      ${listaHtml}
      <div class="text-end fw-bold text-danger mt-1">Total Estimado: $${total.toFixed(2)}</div>
    </div>
    <div class="mb-3 small">
      <strong>📍 Destino:</strong> ${datosCheckout.ubicacion}<br>
      <strong>💳 Método de Pago:</strong> ${datosCheckout.formaPago}
    </div>
    <hr class="my-2 border-secondary">
    <div class="mb-2">
      <label class="form-label fw-bold text-success mb-1">📱 Confirme su número de WhatsApp para contacto:</label>
      <input type="tel" id="confirmarTelefono" class="form-control border-dark">
      <div class="form-text text-muted small mt-1">En caso de estar equivocado, corríjalo aquí para coordinar la entrega.</div>
    </div>
  `;

  setTimeout(() => {
    const confirmInput = document.querySelector("#confirmarTelefono");
    if (confirmInput) {
      window.itiConfirm = window.intlTelInput(confirmInput, {
        initialCountry: "ve", 
        separateDialCode: true,
        utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js"
      });
      if (cacheUsuario.telefono) {
        window.itiConfirm.setNumber(cacheUsuario.telefono);
      }
    }
  }, 150);

  new bootstrap.Modal(document.getElementById('modalConfirmacionFinal')).show();
}

function regresarAFormulario() { bootstrap.Modal.getInstance(document.getElementById('modalConfirmacionFinal')).hide(); new bootstrap.Modal(document.getElementById('modalSolicitudPago')).show(); }

function ejecutarAccionFinal() {
  let telConfirmado = "";
  
  if (window.itiConfirm) {
    if (!window.itiConfirm.isValidNumber()) {
      return mostrarAviso("Por favor, introduzca un número de teléfono de confirmación válido.");
    }
    telConfirmado = window.itiConfirm.getNumber(); 
  } else {
    telConfirmado = document.getElementById('confirmarTelefono').value.trim();
    if (!telConfirmado) return mostrarAviso("El número de teléfono es obligatorio.");
  }

  const numeroOriginal = cacheUsuario.telefono;
  if (telConfirmado !== numeroOriginal) {
    cacheUsuario.telefono = telConfirmado;
    
    callAPI("actualizarTelefonoCliente", { cedula: cacheUsuario.cedula, nuevoTelefono: telConfirmado })
      .catch(function(err) {
        console.error("Error al actualizar teléfono en base de datos:", err);
      });
  }

  const btn = document.getElementById('btnAceptarFinal'); 
  btn.disabled = true; 
  btn.textContent = "Procesando...";
  
  let arr = [], total = 0, listaWA = "";
  for (let p in carrito) {
    arr.push(`${p} (${carrito[p].cantidad})`);
    listaWA += `  ▫️ ${p} - ${carrito[p].cantidad}\n`;
    total += parseFloat(carrito[p].precio);
  }

  let pedido = {
    telefono: cacheUsuario.telefono, 
    nombre: cacheUsuario.nombre, apellido: cacheUsuario.apellido,
    ubicacion: datosCheckout.ubicacion, productos: arr.join(" | "), formaPago: datosCheckout.formaPago, montoTotal: total.toFixed(2)
  };

  callAPI("guardarPedido", { pedido: pedido }).then(function(res) {
    btn.disabled = false; 
    btn.textContent = "Aceptar ✓";
    bootstrap.Modal.getInstance(document.getElementById('modalConfirmacionFinal')).hide();
    if (res.error) return alert(res.error);

    let mensajeWA = `📱 *Teléfono:* ${cacheUsuario.telefono}\n👤 *Cliente:* ${cacheUsuario.nombre} ${cacheUsuario.apellido}\n📍 *Ubicación:* ${datosCheckout.ubicacion}\n\n🛒 *Pedido Solicitado:*\n${listaWA}\n💵 *Monto Aproximado:* $${total.toFixed(2)}\n💳 *Forma de Pago:* ${datosCheckout.formaPago}\n\n⚠️ *Nota Importante:* Entiendo y acepto que el monto total reflejado es una estimación. El pago final podría variar dependiendo del peso exacto de los productos al momento de prepararlos y de la tarifa aplicable al servicio de delivery. ✅`;
    window.open(`https://wa.me/584121753275?text=${encodeURIComponent(mensajeWA)}`, '_blank');
    
    document.getElementById('vistaPedido').classList.add('hidden'); document.getElementById('vistaCombos').classList.remove('hidden');
    carrito = {}; new bootstrap.Modal(document.getElementById('modalExito')).show();
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = "Aceptar ✓";
  });
}

function abrirPanelAdmin() {
  document.getElementById('adminCatNombre').value = "";
  document.getElementById('adminCatProdNombre').value = "";
  document.getElementById('adminCatProdPrecio').value = "";
  document.getElementById('adminCatProdImagen').value = "";
  document.getElementById('adminAddProdNombre').value = "";
  document.getElementById('adminAddProdPrecio').value = "";
  document.getElementById('adminAddProdImagen').value = "";
  
  let addSelect = document.getElementById('adminAddCatSelect');
  let delSelect = document.getElementById('adminDelCatSelect');
  
  let optionsHtml = cacheCategorias.map(cat => `<option value="${cat.nombre}">${cat.nombre}</option>`).join('');
  addSelect.innerHTML = optionsHtml;
  delSelect.innerHTML = `<option value="" disabled selected>-- Elija Categoría --</option>` + optionsHtml;
  
  document.getElementById('adminDelProdSelect').innerHTML = `<option value="" disabled selected>-- Primero elija categoría --</option>`;
  
  new bootstrap.Modal(document.getElementById('modalAdminPanel')).show();
}

function cargarProductosParaEliminar(catNombre) {
  let cat = cacheCategorias.find(c => c.nombre === catNombre);
  if (!cat) return;
  let prodSelect = document.getElementById('adminDelProdSelect');
  prodSelect.innerHTML = cat.productos.map(p => `<option value="${p[0]}">${p[0]}</option>`).join('');
}

function ejecutarCrearCategoria() {
  const catNombre = document.getElementById('adminCatNombre').value.trim();
  const prodNombre = document.getElementById('adminCatProdNombre').value.trim();
  const prodPrecio = document.getElementById('adminCatProdPrecio').value.trim();
  const prodImagen = document.getElementById('adminCatProdImagen').value.trim();
  
  if (!catNombre || !prodNombre || !prodPrecio || !prodImagen) {
    return mostrarAviso("Todos los campos son obligatorios.");
  }
  
  const modalEl = document.getElementById('modalAdminPanel');
  const btn = modalEl.querySelector(".btn-success");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  callAPI("crearNuevaCategoria", {
    adminCedula: cacheUsuario.cedula,
    nombreCat: catNombre,
    prodNombre: prodNombre,
    prodPrecio: prodPrecio,
    prodImagen: prodImagen
  }).then(function(res) {
    btn.disabled = false;
    btn.textContent = "Crear Categoría ✓";
    if (res.error) return alert(res.error);
    mostrarAviso("Categoría creada con éxito.");
    bootstrap.Modal.getInstance(modalEl).hide();
    callAPI("obtenerDatosCatalogo").then(renderizarCatalogo);
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = "Crear Categoría ✓";
  });
}

function ejecutarAnexarProducto() {
  const catNombre = document.getElementById('adminAddCatSelect').value;
  const prodNombre = document.getElementById('adminAddProdNombre').value.trim();
  const prodPrecio = document.getElementById('adminAddProdPrecio').value.trim();
  const prodImagen = document.getElementById('adminAddProdImagen').value.trim();
  
  if (!catNombre || !prodNombre || !prodPrecio || !prodImagen) {
    return mostrarAviso("Todos los campos son obligatorios.");
  }
  
  const modalEl = document.getElementById('modalAdminPanel');
  const btn = modalEl.querySelector(".btn-primary");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  callAPI("anexarProductoACategoria", {
    adminCedula: cacheUsuario.cedula,
    nombreCat: catNombre,
    prodNombre: prodNombre,
    prodPrecio: prodPrecio,
    prodImagen: prodImagen
  }).then(function(res) {
    btn.disabled = false;
    btn.textContent = "Anexar Producto ✓";
    if (res.error) return alert(res.error);
    mostrarAviso("Producto anexado con éxito.");
    bootstrap.Modal.getInstance(modalEl).hide();
    callAPI("obtenerDatosCatalogo").then(renderizarCatalogo);
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = "Anexar Producto ✓";
  });
}

function ejecutarEliminarProducto() {
  const catNombre = document.getElementById('adminDelCatSelect').value;
  const prodNombre = document.getElementById('adminDelProdSelect').value;
  
  if (!catNombre || !prodNombre) {
    return mostrarAviso("Seleccione la categoría y el producto a eliminar.");
  }
  
  if (!confirm(`¿Está seguro que desea eliminar permanentemente el producto "${prodNombre}"?`)) return;
  
  const modalEl = document.getElementById('modalAdminPanel');
  const btn = modalEl.querySelector(".btn-danger");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  callAPI("eliminarProductoDeCategoria", {
    adminCedula: cacheUsuario.cedula,
    nombreCat: catNombre,
    prodNombre: prodNombre
  }).then(function(res) {
    btn.disabled = false;
    btn.textContent = "Eliminar Producto ✕";
    if (res.error) return alert(res.error);
    mostrarAviso("Producto eliminado con éxito.");
    bootstrap.Modal.getInstance(modalEl).hide();
    callAPI("obtenerDatosCatalogo").then(renderizarCatalogo);
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = "Eliminar Producto ✕";
  });
}

function mostrarImagenGrande(url) { document.getElementById('imagenGrandePopUp').src = url; document.getElementById('overlayImagenGrande').classList.add('show'); }
function cerrarImagenGrande(e) { if (e.target.id !== 'imagenGrandePopUp') document.getElementById('overlayImagenGrande').classList.remove('show'); }
