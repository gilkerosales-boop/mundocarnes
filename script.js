/* ==========================================================================
   Frigorífico Mundocarnes - Web Pública & Modo Editor Administrador
   Archivo Oficial Completo y Definitivo: script.js
   ========================================================================== */

// ==========================================================================
// 1. CONFIGURACIÓN GLOBAL, SERVICIOS Y CONSTANTES
// ==========================================================================

const SUPABASE_URL = 'https://bdhlgiygrozdebhmwyds.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_qA5isaOYl_QZzB_WiZsIPA_zjWnTO_6';
const GITHUB_OWNER = 'gilkerosales-boop';
const GITHUB_REPO = 'mundocarnes';
const GITHUB_BRANCH = 'main';
const GITHUB_CATALOG_PATH = 'catalog.json';
const WHATSAPP_NUMERO = '584121753275';

// Inicialización de Supabase SDK v2
let supabaseClient = null;
if (typeof supabase !== 'undefined') {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Variables de Estado de la Aplicación
let catalogoData = { categorias: [] };
let catalogoShaGitHub = '';
let carrito = JSON.parse(localStorage.getItem('mundocarnes_carrito')) || [];
let clienteActual = JSON.parse(localStorage.getItem('mundocarnes_cliente')) || null;
let adminAutenticado = false;
let datosAdminSesion = null;
let githubTokenAdmin = localStorage.getItem('mundocarnes_gh_token') || '';

// Punteros de Navegación y Edición
let categoriaActivaIndex = 0;
let productoSeleccionadoActual = null;
let productoEnEdicion = null; // { catIndex, prodIndex, esNuevo: boolean }
let itiInstance = null;
let filtroBusquedaActual = '';

// ==========================================================================
// 2. INICIALIZACIÓN DEL DOM Y REGISTRO DE EVENTOS
// ==========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  inicializarListenersGenerales();
  await cargarCatalogo();
  evaluarModoAdmin();
  actualizarUI();
});

function inicializarListenersGenerales() {
  // Manejo de la navegación por historial y teclado para el visor de imágenes
  window.addEventListener('popstate', (e) => {
    cerrarZoomImagen();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cerrarZoomImagen();
    }
  });

  const btnCerrarZoom = document.getElementById('btnCerrarZoom');
  if (btnCerrarZoom) {
    btnCerrarZoom.addEventListener('click', cerrarZoomImagen);
  }

  // Prevenir envíos de formulario nativos
  const formIdentificar = document.getElementById('formIdentificarCliente');
  if (formIdentificar) {
    formIdentificar.addEventListener('submit', (e) => {
      e.preventDefault();
      verificarCedulaCliente();
    });
  }

  const formRegistro = document.getElementById('formRegistroNuevoCliente');
  if (formRegistro) {
    formRegistro.addEventListener('submit', (e) => {
      e.preventDefault();
      registrarClienteWeb(e);
    });
  }

  const inputBuscar = document.getElementById('inputBuscarWeb');
  if (inputBuscar) {
    inputBuscar.addEventListener('input', (e) => {
      filtroBusquedaActual = e.target.value.trim().toLowerCase();
      renderizarCatalogo();
    });
  }
}

// ==========================================================================
// 3. CARGA Y SINCRONIZACIÓN LOCAL DE CATALOG.JSON
// ==========================================================================

async function cargarCatalogo() {
  try {
    const res = await fetch(`catalog.json?t=${new Date().getTime()}`);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    catalogoData = await res.json();

    if (!catalogoData.categorias || !Array.isArray(catalogoData.categorias)) {
      catalogoData = { categorias: [] };
    }

    renderizarCatalogo();
  } catch (error) {
    console.error('Error al cargar catalog.json:', error);
    mostrarToast('Error al cargar el catálogo de productos.');
  }
}

// ==========================================================================
// 4. RENDERIZADO COMPLETO DEL CATÁLOGO (CLIENTE & MODO EDITOR)
// ==========================================================================

function renderizarCatalogo() {
  const tabsContainer = document.getElementById('navTabsCategorias');
  const contentContainer = document.getElementById('tabContentCategorias');
  if (!tabsContainer || !contentContainer) return;

  tabsContainer.innerHTML = '';
  contentContainer.innerHTML = '';

  if (catalogoData.categorias.length === 0) {
    contentContainer.innerHTML = '<div class="alert alert-warning text-center fw-bold">No hay categorías registradas en el catálogo.</div>';
    return;
  }

  // Ajustar índice activo si está fuera de rango
  if (categoriaActivaIndex >= catalogoData.categorias.length) {
    categoriaActivaIndex = 0;
  }

  catalogoData.categorias.forEach((cat, index) => {
    const isActive = index === categoriaActivaIndex;
    const catId = `cat-tab-${index}`;
    const contentId = `cat-content-${index}`;

    // Pestaña
    const li = document.createElement('li');
    li.className = 'nav-item';
    li.role = 'presentation';
    li.innerHTML = `
      <button class="nav-link ${isActive ? 'active' : ''}" id="${catId}" data-bs-toggle="tab" data-bs-target="#${contentId}" type="button" role="tab" onclick="categoriaActivaIndex = ${index}">
        ${cat.nombre}
      </button>
    `;
    tabsContainer.appendChild(li);

    // Panel de Contenido
    const pane = document.createElement('div');
    pane.className = `tab-pane fade ${isActive ? 'show active' : ''}`;
    pane.id = contentId;
    pane.role = 'tabpanel';

    let htmlGrid = '';

    // Barra de acciones de categoría en Modo Administrador
    if (adminAutenticado) {
      htmlGrid += `
        <div class="d-flex justify-content-between align-items-center mb-3 bg-light p-2 rounded border border-dark flex-wrap gap-2">
          <div class="d-flex align-items-center gap-1">
            <span class="badge bg-dark fs-6">${cat.nombre}</span>
            <small class="text-muted fw-bold">(${cat.productos.length} productos)</small>
          </div>
          <div class="d-flex gap-1">
            <button type="button" class="btn btn-sm btn-outline-dark fw-bold" onclick="moverCategoriaOrden(${index}, -1)" ${index === 0 ? 'disabled' : ''} title="Mover categoría a la izquierda">⬅️</button>
            <button type="button" class="btn btn-sm btn-outline-dark fw-bold" onclick="moverCategoriaOrden(${index}, 1)" ${index === catalogoData.categorias.length - 1 ? 'disabled' : ''} title="Mover categoría a la derecha">➡️</button>
            <button type="button" class="btn btn-sm btn-outline-primary fw-bold" onclick="abrirModalRenombrarCategoria(${index})" title="Renombrar Categoría">✏️ Renombrar</button>
            <button type="button" class="btn btn-sm btn-outline-danger fw-bold" onclick="eliminarCategoriaAdmin(${index})" title="Eliminar Categoría">🗑️</button>
            <button type="button" class="btn btn-sm btn-success fw-bold border-dark ms-2" onclick="abrirModalNuevoProducto(${index})">
              ➕ Agregar Producto
            </button>
          </div>
        </div>
      `;
    }

    htmlGrid += '<div class="row g-3 justify-content-start">';

    // Filtrar productos si hay búsqueda activa
    const productosFiltrados = cat.productos.map((p, originalIndex) => ({ prod: p, originalIndex })).filter(item => {
      if (!filtroBusquedaActual) return true;
      const nombreProd = (item.prod[0] || '').toLowerCase();
      const pluProd = (item.prod[7] || '').toLowerCase();
      return nombreProd.includes(filtroBusquedaActual) || pluProd.includes(filtroBusquedaActual);
    });

    if (productosFiltrados.length === 0) {
      htmlGrid += `
        <div class="col-12 text-center text-muted py-4">
          <p>No se encontraron productos en esta categoría${filtroBusquedaActual ? ' con el filtro actual' : ''}.</p>
        </div>
      `;
    } else {
      productosFiltrados.forEach(({ prod, originalIndex }) => {
        const [nombre, precio, img, disponible, cantMin, tipoUnidad, pesoAprox, plu] = prod;
        const claseAgotado = !disponible ? 'img-agotado' : '';

        let etiquetaPrecio = `$${parseFloat(precio || 0).toFixed(2)}`;
        let unidadTexto = 'Venta por unidades';

        if (tipoUnidad === 'gramos') {
          etiquetaPrecio = `$${parseFloat(precio || 0).toFixed(2)}`;
          unidadTexto = `Mín: ${cantMin || 100}g (Precio / 100g)`;
        } else if (tipoUnidad === 'mixto') {
          etiquetaPrecio = `$${parseFloat(precio || 0).toFixed(2)}`;
          unidadTexto = `Mín: ${cantMin || 1} uds (~${((pesoAprox || 1000) / 1000).toFixed(2)} Kg/ud)`;
        } else {
          unidadTexto = `Mín: ${cantMin || 1} uds`;
        }

        htmlGrid += `
          <div class="col-12 col-sm-6 col-md-4 col-lg-3">
            <div class="card h-100 shadow-sm position-relative border-dark">
              ${!disponible ? '<span class="badge bg-danger position-absolute top-0 end-0 m-2 fw-bold shadow">AGOTADO</span>' : ''}
              ${plu ? `<span class="badge bg-dark position-absolute top-0 start-0 m-2 font-monospace shadow">PLU: ${plu}</span>` : ''}

              <img src="${img}" class="card-img-top ${claseAgotado}" alt="${nombre}" onclick="abrirZoomImagen('${img}', '${nombre}', ${precio}, '${tipoUnidad}', ${index}, ${originalIndex})" onerror="this.src='img/LOGO-MUNDO123.webp'">

              <div class="card-body d-flex flex-column justify-content-between p-3">
                <div>
                  <h6 class="card-title fw-bold text-dark text-truncate mb-1" title="${nombre}">${nombre}</h6>
                  <div class="d-flex align-items-baseline gap-1 mb-1">
                    <span class="text-success fw-bold fs-5">${etiquetaPrecio}</span>
                    <small class="text-muted fw-bold">${tipoUnidad === 'gramos' ? '/ 100g' : (tipoUnidad === 'mixto' ? '/ Kg' : '')}</small>
                  </div>
                  <small class="text-muted d-block mb-2">${unidadTexto}</small>
                </div>

                <div class="mt-2">
                  ${adminAutenticado ? `
                    <div class="d-flex flex-column gap-1">
                      <button type="button" class="btn btn-warning w-100 fw-bold border-dark btn-sm text-dark" onclick="abrirModalEditor(${index}, ${originalIndex})">
                        ⚙️ Configurar
                      </button>
                      <div class="btn-group w-100 btn-group-sm">
                        <button type="button" class="btn btn-outline-dark" title="Subir Posición" onclick="moverPosicionProducto(${index}, ${originalIndex}, -1)" ${originalIndex === 0 ? 'disabled' : ''}>⬆️</button>
                        <button type="button" class="btn btn-outline-dark" title="Bajar Posición" onclick="moverPosicionProducto(${index}, ${originalIndex}, 1)" ${originalIndex === cat.productos.length - 1 ? 'disabled' : ''}>⬇️</button>
                        <button type="button" class="btn btn-outline-danger" title="Eliminar Producto" onclick="eliminarProductoAdmin(${index}, ${originalIndex})">🗑️</button>
                      </div>
                    </div>
                  ` : `
                    <button type="button" class="btn btn-danger w-100 fw-bold border-dark btn-sm" ${!disponible ? 'disabled' : ''} onclick="abrirModalSeleccionCantidad(${index}, ${originalIndex})">
                      ${!disponible ? 'Agotado' : 'Seleccionar +'}
                    </button>
                  `}
                </div>
              </div>
            </div>
          </div>
        `;
      });
    }

    htmlGrid += '</div>';
    pane.innerHTML = htmlGrid;
    contentContainer.appendChild(pane);
  });
}

// ==========================================================================
// 5. MODAL DE SELECCIÓN DE CANTIDAD / PESO CON CHIPS RÁPIDOS
// ==========================================================================

function abrirModalSeleccionCantidad(catIndex, prodIndex) {
  const prod = catalogoData.categorias[catIndex].productos[prodIndex];
  productoSeleccionadoActual = { catIndex, prodIndex, prod };

  const [nombre, precio, img, disponible, cantMin, tipoUnidad, pesoAprox] = prod;

  const elNombre = document.getElementById('modalSeleccionNombre');
  const elPrecio = document.getElementById('modalSeleccionPrecio');
  const contUnidades = document.getElementById('modalContUnidades');
  const contGramos = document.getElementById('modalContGramos');
  const errorEl = document.getElementById('errorModalSeleccion');

  if (elNombre) elNombre.innerText = nombre;
  if (elPrecio) {
    if (tipoUnidad === 'gramos') {
      elPrecio.innerText = `$${precio.toFixed(2)} por cada 100g (Mínimo: ${cantMin || 100}g)`;
    } else if (tipoUnidad === 'mixto') {
      elPrecio.innerText = `$${precio.toFixed(2)} / Kg (~${pesoAprox || 1000}g por unidad aprox.)`;
    } else {
      elPrecio.innerText = `$${precio.toFixed(2)} c/u (Mínimo: ${cantMin || 1} uds)`;
    }
  }

  if (errorEl) errorEl.classList.add('hidden');

  if (tipoUnidad === 'gramos') {
    if (contUnidades) contUnidades.classList.add('hidden');
    if (contGramos) contGramos.classList.remove('hidden');
    const inputGramos = document.getElementById('modalInputGramos');
    if (inputGramos) {
      inputGramos.value = cantMin || 250;
      inputGramos.min = cantMin || 50;
      inputGramos.step = 50;
      actualizarCalculoGramosModal();
    }
  } else {
    if (contGramos) contGramos.classList.add('hidden');
    if (contUnidades) contUnidades.classList.remove('hidden');
    const inputUnidades = document.getElementById('modalInputUnidades');
    if (inputUnidades) {
      inputUnidades.value = cantMin || 1;
      inputUnidades.min = cantMin || 1;
      actualizarCalculoUnidadesModal();
    }
  }

  const modalEl = document.getElementById('modalSeleccionProducto');
  if (modalEl) {
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  }
}

// Botones rápidos de selección de peso (+100g, +250g, +500g, +1kg, etc.)
function fijarGramosRapidos(gramos) {
  const input = document.getElementById('modalInputGramos');
  if (input) {
    input.value = gramos;
    actualizarCalculoGramosModal();
  }
}

function sumarGramosRapidos(gramosExtra) {
  const input = document.getElementById('modalInputGramos');
  if (input) {
    let actual = parseFloat(input.value) || 0;
    input.value = actual + gramosExtra;
    actualizarCalculoGramosModal();
  }
}

function fijarUnidadesRapidas(uds) {
  const input = document.getElementById('modalInputUnidades');
  if (input) {
    input.value = uds;
    actualizarCalculoUnidadesModal();
  }
}

function sumarUnidadesRapidas(udsExtra) {
  const input = document.getElementById('modalInputUnidades');
  if (input) {
    let actual = parseInt(input.value) || 0;
    input.value = Math.max(1, actual + udsExtra);
    actualizarCalculoUnidadesModal();
  }
}

function actualizarCalculoGramosModal() {
  if (!productoSeleccionadoActual) return;
  const { prod } = productoSeleccionadoActual;
  const precio100g = prod[1];
  const input = document.getElementById('modalInputGramos');
  const labelSubtotal = document.getElementById('modalSubtotalCalculadoGramos');
  if (!input || !labelSubtotal) return;

  const gramos = parseFloat(input.value) || 0;
  const subtotal = (gramos / 100) * precio100g;
  labelSubtotal.innerText = `Subtotal: $${subtotal.toFixed(2)} (${(gramos / 1000).toFixed(3)} Kg)`;
}

function actualizarCalculoUnidadesModal() {
  if (!productoSeleccionadoActual) return;
  const { prod } = productoSeleccionadoActual;
  const [, precio, , , , tipoUnidad, pesoAprox] = prod;
  const input = document.getElementById('modalInputUnidades');
  const labelSubtotal = document.getElementById('modalSubtotalCalculadoUnidades');
  if (!input || !labelSubtotal) return;

  const uds = parseInt(input.value) || 0;
  if (tipoUnidad === 'mixto') {
    const pesoKg = (uds * (pesoAprox || 1000)) / 1000;
    const subtotal = pesoKg * precio;
    labelSubtotal.innerText = `Subtotal: $${subtotal.toFixed(2)} (~${pesoKg.toFixed(2)} Kg)`;
  } else {
    const subtotal = uds * precio;
    labelSubtotal.innerText = `Subtotal: $${subtotal.toFixed(2)}`;
  }
}

function confirmarAgregarCarrito() {
  if (!productoSeleccionadoActual) return;
  const { prod } = productoSeleccionadoActual;
  const [nombre, precio, img, disponible, cantMin, tipoUnidad, pesoAprox, plu] = prod;

  let cantidad = 1;
  let subtotal = 0;
  let detalleCantidad = '';

  if (tipoUnidad === 'gramos') {
    const gramos = parseFloat(document.getElementById('modalInputGramos').value) || 0;
    const minGramos = cantMin || 100;
    if (gramos < minGramos) {
      mostrarErrorModalSeleccion(`La cantidad mínima para este producto es de ${minGramos}g`);
      return;
    }
    cantidad = gramos;
    subtotal = (gramos / 100) * precio;
    detalleCantidad = `${gramos}g (${(gramos / 1000).toFixed(2)} Kg)`;
  } else if (tipoUnidad === 'mixto') {
    const uds = parseInt(document.getElementById('modalInputUnidades').value) || 0;
    const minUds = cantMin || 1;
    if (uds < minUds) {
      mostrarErrorModalSeleccion(`La cantidad mínima es de ${minUds} unidades.`);
      return;
    }
    cantidad = uds;
    const pesoUnitarioKg = (pesoAprox || 1000) / 1000;
    const pesoTotalKg = uds * pesoUnitarioKg;
    subtotal = pesoTotalKg * precio;
    detalleCantidad = `${uds} uds (~${pesoTotalKg.toFixed(2)} Kg)`;
  } else {
    const uds = parseInt(document.getElementById('modalInputUnidades').value) || 0;
    const minUds = cantMin || 1;
    if (uds < minUds) {
      mostrarErrorModalSeleccion(`La cantidad mínima es de ${minUds} unidades.`);
      return;
    }
    cantidad = uds;
    subtotal = uds * precio;
    detalleCantidad = `${uds} uds`;
  }

  // Verificar si ya existe en el carrito
  const indexExistente = carrito.findIndex(item => item.nombre === nombre && item.tipoUnidad === tipoUnidad);
  if (indexExistente !== -1) {
    carrito[indexExistente].cantidad += cantidad;
    carrito[indexExistente].subtotal += subtotal;
    if (tipoUnidad === 'gramos') {
      const totG = carrito[indexExistente].cantidad;
      carrito[indexExistente].detalleCantidad = `${totG}g (${(totG / 1000).toFixed(2)} Kg)`;
    } else if (tipoUnidad === 'mixto') {
      const totUds = carrito[indexExistente].cantidad;
      const pesoTotalKg = (totUds * (pesoAprox || 1000)) / 1000;
      carrito[indexExistente].detalleCantidad = `${totUds} uds (~${pesoTotalKg.toFixed(2)} Kg)`;
    } else {
      carrito[indexExistente].detalleCantidad = `${carrito[indexExistente].cantidad} uds`;
    }
  } else {
    carrito.push({
      nombre,
      precioBase: precio,
      tipoUnidad,
      pesoAprox,
      cantidad,
      subtotal,
      detalleCantidad,
      img
    });
  }

  guardarCarrito();

  const modalEl = document.getElementById('modalSeleccionProducto');
  const modalInstance = bootstrap.Modal.getInstance(modalEl);
  if (modalInstance) modalInstance.hide();

  mostrarToast(`¡${nombre} añadido a tu pedido!`);
}

function mostrarErrorModalSeleccion(msg) {
  const err = document.getElementById('errorModalSeleccion');
  if (err) {
    err.innerText = msg;
    err.classList.remove('hidden');
  }
}

// ==========================================================================
// 6. GESTIÓN DEL CARRITO DE COMPRAS Y PEDIDOS
// ==========================================================================

function guardarCarrito() {
  localStorage.setItem('mundocarnes_carrito', JSON.stringify(carrito));
  actualizarUI();
}

function modificarCantidadCarrito(index, cambio) {
  const item = carrito[index];
  if (!item) return;

  if (item.tipoUnidad === 'gramos') {
    item.cantidad += (cambio * 100);
    if (item.cantidad <= 0) {
      carrito.splice(index, 1);
    } else {
      item.subtotal = (item.cantidad / 100) * item.precioBase;
      item.detalleCantidad = `${item.cantidad}g (${(item.cantidad / 1000).toFixed(2)} Kg)`;
    }
  } else if (item.tipoUnidad === 'mixto') {
    item.cantidad += cambio;
    if (item.cantidad <= 0) {
      carrito.splice(index, 1);
    } else {
      const pesoKg = (item.cantidad * (item.pesoAprox || 1000)) / 1000;
      item.subtotal = pesoKg * item.precioBase;
      item.detalleCantidad = `${item.cantidad} uds (~${pesoKg.toFixed(2)} Kg)`;
    }
  } else {
    item.cantidad += cambio;
    if (item.cantidad <= 0) {
      carrito.splice(index, 1);
    } else {
      item.subtotal = item.cantidad * item.precioBase;
      item.detalleCantidad = `${item.cantidad} uds`;
    }
  }

  guardarCarrito();
  renderizarCarritoModal();
}

function eliminarItemCarrito(index) {
  carrito.splice(index, 1);
  guardarCarrito();
  renderizarCarritoModal();
}

function vaciarCarrito() {
  carrito = [];
  guardarCarrito();
  renderizarCarritoModal();
}

function actualizarUI() {
  const btnFlotante = document.getElementById('btnVerPedidoFlotante');
  const badgeCant = document.getElementById('cantItemsFlotante');
  const totalFlotante = document.getElementById('totalPedidoFlotante');

  const totalItems = carrito.length;
  const totalMonto = carrito.reduce((acc, item) => acc + item.subtotal, 0);

  if (badgeCant) badgeCant.innerText = totalItems;
  if (totalFlotante) totalFlotante.innerText = `$${totalMonto.toFixed(2)}`;

  if (btnFlotante) {
    if (carrito.length > 0) {
      btnFlotante.classList.remove('hidden');
    } else {
      btnFlotante.classList.add('hidden');
    }
  }
}

function abrirModalPedido() {
  renderizarCarritoModal();
  const modalEl = document.getElementById('modalPedido');
  if (modalEl) {
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  }
}

function renderizarCarritoModal() {
  const container = document.getElementById('listaProductosPedido');
  const totalEl = document.getElementById('montoTotalPedidoModal');
  if (!container || !totalEl) return;

  if (carrito.length === 0) {
    container.innerHTML = '<p class="text-center text-muted py-4">Tu pedido está actualmente vacío.</p>';
    totalEl.innerText = '$0.00';
    return;
  }

  let html = '<div class="list-group list-group-flush">';
  let total = 0;

  carrito.forEach((item, index) => {
    total += item.subtotal;
    html += `
      <div class="list-group-item d-flex justify-content-between align-items-center px-0 py-2 border-bottom">
        <div class="d-flex align-items-center gap-2">
          <img src="${item.img}" alt="${item.nombre}" style="width: 48px; height: 48px; object-fit: cover;" class="rounded border" onerror="this.src='img/LOGO-MUNDO123.webp'">
          <div>
            <div class="fw-bold text-dark text-truncate" style="max-width: 190px;">${item.nombre}</div>
            <small class="text-muted">${item.detalleCantidad} &bull; <strong class="text-success">$${item.subtotal.toFixed(2)}</strong></small>
          </div>
        </div>
        <div class="d-flex align-items-center gap-1">
          <button type="button" class="btn btn-sm btn-outline-secondary px-2" onclick="modificarCantidadCarrito(${index}, -1)">-</button>
          <button type="button" class="btn btn-sm btn-outline-secondary px-2" onclick="modificarCantidadCarrito(${index}, 1)">+</button>
          <button type="button" class="btn btn-sm btn-outline-danger fw-bold ms-1" onclick="eliminarItemCarrito(${index})" title="Quitar">✕</button>
        </div>
      </div>
    `;
  });
  html += '</div>';

  container.innerHTML = html;
  totalEl.innerText = `$${total.toFixed(2)}`;
}

// ==========================================================================
// 7. CONSULTA Y REGISTRO DE CLIENTES (CORRECCIÓN POSTGREST SUPABASE)
// ==========================================================================

function iniciarCheckout() {
  if (carrito.length === 0) return;

  const modalPedido = bootstrap.Modal.getInstance(document.getElementById('modalPedido'));
  if (modalPedido) modalPedido.hide();

  if (clienteActual && clienteActual.CEDULA) {
    solicitarConfirmacionWhatsApp();
  } else {
    abrirModalIdentificacionCliente();
  }
}

function abrirModalIdentificacionCliente() {
  const modalEl = document.getElementById('modalIdentificarCliente');
  if (!modalEl) return;

  const boxIngreso = document.getElementById('boxIngresoCedula');
  const boxRegistro = document.getElementById('boxRegistroNuevoCliente');
  const inputCedula = document.getElementById('inputCedulaIdentificar');

  if (boxIngreso) boxIngreso.classList.remove('hidden');
  if (boxRegistro) boxRegistro.classList.add('hidden');
  if (inputCedula) {
    inputCedula.value = '';
    setTimeout(() => inputCedula.focus(), 350);
  }

  const modal = new bootstrap.Modal(modalEl);
  modal.show();
}

// Consulta exacta con la columna PostgreSQL "CEDULA" (Evita error 400 Bad Request)
async function verificarCedulaCliente() {
  const cedulaInput = document.getElementById('inputCedulaIdentificar');
  if (!cedulaInput) return;

  const cedulaLimpia = cedulaInput.value.trim().toUpperCase();
  if (!cedulaLimpia) {
    mostrarToast('Por favor ingrese su Cédula o RIF.');
    return;
  }

  const btnContinuar = document.getElementById('btnContinuarIdentificacion');
  if (btnContinuar) {
    btnContinuar.disabled = true;
    btnContinuar.innerText = 'Consultando... ⏳';
  }

  try {
    if (!supabaseClient) throw new Error('Cliente Supabase no inicializado');

    const { data, error } = await supabaseClient
      .from('clientes')
      .select('*')
      .eq('CEDULA', cedulaLimpia)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      clienteActual = {
        CEDULA: data.CEDULA,
        NOMBRES: data.NOMBRES || '',
        APELLIDOS: data.APELLIDOS || '',
        TELEFONO: data.TELEFONO || '',
        DIRECCION: data.DIRECCION || ''
      };
      localStorage.setItem('mundocarnes_cliente', JSON.stringify(clienteActual));

      const modalInstance = bootstrap.Modal.getInstance(document.getElementById('modalIdentificarCliente'));
      if (modalInstance) modalInstance.hide();

      solicitarConfirmacionWhatsApp();
    } else {
      mostrarFormularioRegistroNuevoCliente(cedulaLimpia);
    }
  } catch (err) {
    console.error('Error al consultar cliente en Supabase:', err);
    mostrarFormularioRegistroNuevoCliente(cedulaLimpia);
  } finally {
    if (btnContinuar) {
      btnContinuar.disabled = false;
      btnContinuar.innerText = 'Continuar ➡️';
    }
  }
}

function mostrarFormularioRegistroNuevoCliente(cedula) {
  const boxIngreso = document.getElementById('boxIngresoCedula');
  const boxRegistro = document.getElementById('boxRegistroNuevoCliente');
  const regCedula = document.getElementById('regClienteCedula');

  if (boxIngreso) boxIngreso.classList.add('hidden');
  if (boxRegistro) boxRegistro.classList.remove('hidden');
  if (regCedula) regCedula.value = cedula;

  const telInput = document.getElementById('regClienteTelefono');
  if (telInput && typeof window.intlTelInput !== 'undefined' && !itiInstance) {
    itiInstance = window.intlTelInput(telInput, {
      initialCountry: 've',
      preferredCountries: ['ve', 'co', 'us', 'es'],
      separateDialCode: true,
      utilsScript: 'https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js'
    });
  }
}

// Inserción exacta con nombres de columna: "CEDULA", "NOMBRES", "APELLIDOS", "TELEFONO", "DIRECCION"
async function registrarClienteWeb(event) {
  if (event) event.preventDefault();

  const cedula = document.getElementById('regClienteCedula').value.trim().toUpperCase();
  const nombres = document.getElementById('regClienteNombres').value.trim().toUpperCase();
  const apellidos = document.getElementById('regClienteApellidos').value.trim().toUpperCase();
  const direccion = (document.getElementById('regClienteDireccion') ? document.getElementById('regClienteDireccion').value.trim().toUpperCase() : '') || 'PARRAL';

  let telefono = '';
  if (itiInstance) {
    telefono = itiInstance.getNumber();
  } else {
    telefono = document.getElementById('regClienteTelefono').value.trim();
  }

  if (!cedula || !nombres || !apellidos || !telefono) {
    mostrarToast('Por favor complete todos los campos obligatorios.');
    return;
  }

  const payloadCliente = {
    "CEDULA": cedula,
    "NOMBRES": nombres,
    "APELLIDOS": apellidos,
    "TELEFONO": telefono,
    "DIRECCION": direccion
  };

  const btnReg = document.getElementById('btnRegistrarClienteWeb');
  if (btnReg) {
    btnReg.disabled = true;
    btnReg.innerText = 'Registrando... ⏳';
  }

  try {
    if (supabaseClient) {
      const { error } = await supabaseClient
        .from('clientes')
        .upsert([payloadCliente], { onConflict: 'CEDULA' });

      if (error) console.warn('Aviso Supabase clientes:', error.message);
    }
  } catch (err) {
    console.warn('Error al guardar cliente en Supabase:', err);
  } finally {
    if (btnReg) {
      btnReg.disabled = false;
      btnReg.innerText = 'Registrarse y Comprar 🚀';
    }
  }

  clienteActual = payloadCliente;
  localStorage.setItem('mundocarnes_cliente', JSON.stringify(clienteActual));

  const modalEl = document.getElementById('modalIdentificarCliente');
  const modalInstance = bootstrap.Modal.getInstance(modalEl);
  if (modalInstance) modalInstance.hide();

  solicitarConfirmacionWhatsApp();
}

// ==========================================================================
// 8. GENERACIÓN DEL PEDIDO OFICIAL PARA WHATSAPP
// ==========================================================================

function solicitarConfirmacionWhatsApp() {
  if (!clienteActual || carrito.length === 0) return;

  const total = carrito.reduce((acc, item) => acc + item.subtotal, 0);

  let msg = `*🥩 ¡HOLA FRIGORÍFICO MUNDOCARNES! Deseo formalizar el siguiente pedido:*\n\n`;
  msg += `👤 *Cliente:* ${clienteActual.NOMBRES} ${clienteActual.APELLIDOS}\n`;
  msg += `🪪 *Cédula/RIF:* ${clienteActual.CEDULA}\n`;
  msg += `📞 *Teléfono:* ${clienteActual.TELEFONO}\n`;
  if (clienteActual.DIRECCION && clienteActual.DIRECCION !== '') {
    msg += `📍 *Ubicación / Sector:* ${clienteActual.DIRECCION}\n`;
  }
  msg += `\n-----------------------------------------\n`;
  msg += `📋 *DETALLE DEL PEDIDO:*\n`;

  carrito.forEach((item, index) => {
    msg += `• *${item.nombre}* (${item.detalleCantidad}) - $${item.subtotal.toFixed(2)}\n`;
  });

  msg += `-----------------------------------------\n`;
  msg += `💵 *MONTO TOTAL ESTIMADO:* $${total.toFixed(2)}\n\n`;
  msg += `Quedo a la espera de su confirmación para proceder con el pago y retiro/entrega. ¡Muchas gracias!`;

  const url = `https://wa.me/${WHATSAPP_NUMERO}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}

// ==========================================================================
// 9. VISOR DE ZOOM DE IMÁGENES Y CONTROL POPSTATE
// ==========================================================================

function abrirZoomImagen(imgUrl, nombre, precio, tipoUnidad, catIndex, prodIndex) {
  const overlay = document.getElementById('overlayImagenGrande');
  const imgPopUp = document.getElementById('imagenGrandePopUp');
  const btnSeleccionar = document.getElementById('btnSeleccionarZoom');
  if (!overlay || !imgPopUp) return;

  imgPopUp.src = imgUrl;

  if (btnSeleccionar) {
    btnSeleccionar.onclick = () => {
      cerrarZoomImagen();
      if (adminAutenticado) {
        abrirModalEditor(catIndex, prodIndex);
      } else {
        abrirModalSeleccionCantidad(catIndex, prodIndex);
      }
    };
  }

  overlay.classList.add('show');
  history.pushState({ modalZoom: true }, '');
}

function cerrarZoomImagen() {
  const overlay = document.getElementById('overlayImagenGrande');
  if (overlay && overlay.classList.contains('show')) {
    overlay.classList.remove('show');
  }
}

// ==========================================================================
// 10. MODO EDITOR / ADMINISTRADOR (?admin) Y AUTENTICACIÓN
// ==========================================================================

function evaluarModoAdmin() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('admin')) {
    const sesionGuardada = localStorage.getItem('mundocarnes_admin_sesion');
    if (sesionGuardada) {
      try {
        datosAdminSesion = JSON.parse(sesionGuardada);
        adminAutenticado = true;
        mostrarBarraEditor(datosAdminSesion.NOMBRE || 'ADMINISTRADOR');
        renderizarCatalogo();
      } catch (e) {
        abrirModalLoginAdmin();
      }
    } else {
      abrirModalLoginAdmin();
    }
  }
}

function abrirModalLoginAdmin() {
  const modalEl = document.getElementById('modalLoginAdmin');
  if (!modalEl) return;
  const modal = new bootstrap.Modal(modalEl);
  modal.show();
}

// Autenticación en tabla "administradores" con columnas exactas: "CEDULA", "CLAVE"
async function procesarLoginAdmin(event) {
  if (event) event.preventDefault();

  const cedula = document.getElementById('adminLoginCedula').value.trim().toUpperCase();
  const clave = document.getElementById('adminLoginClave').value.trim();
  const errorEl = document.getElementById('errorModalLoginAdmin');

  if (errorEl) errorEl.classList.add('hidden');

  try {
    if (!supabaseClient) throw new Error('Supabase no inicializado');

    const { data, error } = await supabaseClient
      .from('administradores')
      .select('*')
      .eq('CEDULA', cedula)
      .eq('CLAVE', clave)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      adminAutenticado = true;
      datosAdminSesion = data;
      localStorage.setItem('mundocarnes_admin_sesion', JSON.stringify({
        CEDULA: data.CEDULA,
        NOMBRE: data.NOMBRE,
        APELLIDO: data.APELLIDO
      }));

      const modalEl = document.getElementById('modalLoginAdmin');
      const modalInstance = bootstrap.Modal.getInstance(modalEl);
      if (modalInstance) modalInstance.hide();

      mostrarBarraEditor(data.NOMBRE || 'ADMIN');
      renderizarCatalogo();
      mostrarToast(`¡Bienvenido ${data.NOMBRE || 'Administrador'}!`);
    } else {
      if (errorEl) {
        errorEl.innerText = 'Cédula o Clave de Administrador incorrecta.';
        errorEl.classList.remove('hidden');
      }
    }
  } catch (err) {
    console.error('Error autenticando admin en Supabase:', err);
    if (errorEl) {
      errorEl.innerText = 'Error de conexión al autenticar administrador.';
      errorEl.classList.remove('hidden');
    }
  }
}

function mostrarBarraEditor(nombreUsuario) {
  const bar = document.getElementById('barraModoEditor');
  const lbl = document.getElementById('editorUsuarioNombre');
  if (bar) bar.classList.remove('hidden');
  if (lbl) lbl.innerText = nombreUsuario;
}

function cerrarSesionAdmin() {
  localStorage.removeItem('mundocarnes_admin_sesion');
  adminAutenticado = false;
  datosAdminSesion = null;
  window.location.href = window.location.pathname;
}

// ==========================================================================
// 11. PANEL DE CONTROL DASHBOARD & GESTIÓN DE CATEGORÍAS
// ==========================================================================

function abrirPanelDeControlAdmin() {
  const modalEl = document.getElementById('modalPanelControlAdmin');
  if (!modalEl) return;

  // Actualizar métricas del dashboard
  const cntCats = document.getElementById('cntTotalCategoriasAdmin');
  const cntProds = document.getElementById('cntTotalProductosAdmin');
  if (cntCats) cntCats.innerText = catalogoData.categorias.length;
  if (cntProds) {
    const total = catalogoData.categorias.reduce((acc, cat) => acc + cat.productos.length, 0);
    cntProds.innerText = total;
  }

  const modal = new bootstrap.Modal(modalEl);
  modal.show();
}

function abrirModalNuevaCategoria() {
  const nombre = prompt('Ingrese el nombre de la nueva categoría (Ej: ESPECIALIDADES):');
  if (!nombre || !nombre.trim()) return;

  const nombreLimpio = nombre.trim().toUpperCase();
  catalogoData.categorias.push({
    nombre: nombreLimpio,
    productos: []
  });

  categoriaActivaIndex = catalogoData.categorias.length - 1;
  renderizarCatalogo();
  sincronizarCambiosConGitHub(`Agregar categoría ${nombreLimpio}`);
}

function abrirModalRenombrarCategoria(catIndex) {
  const cat = catalogoData.categorias[catIndex];
  if (!cat) return;

  const nuevoNombre = prompt(`Modificar nombre de la categoría:`, cat.nombre);
  if (!nuevoNombre || !nuevoNombre.trim() || nuevoNombre.trim().toUpperCase() === cat.nombre) return;

  const nombreLimpio = nuevoNombre.trim().toUpperCase();
  cat.nombre = nombreLimpio;

  renderizarCatalogo();
  sincronizarCambiosConGitHub(`Renombrar categoría a ${nombreLimpio}`);
}

function eliminarCategoriaAdmin(catIndex) {
  const cat = catalogoData.categorias[catIndex];
  if (!cat) return;

  const confirmacion = confirm(`¿Está seguro de eliminar la categoría "${cat.nombre}" y todos sus ${cat.productos.length} productos?`);
  if (!confirmacion) return;

  catalogoData.categorias.splice(catIndex, 1);
  if (categoriaActivaIndex >= catalogoData.categorias.length) {
    categoriaActivaIndex = Math.max(0, catalogoData.categorias.length - 1);
  }

  renderizarCatalogo();
  sincronizarCambiosConGitHub(`Eliminar categoría ${cat.nombre}`);
}

function moverCategoriaOrden(catIndex, direccion) {
  const nuevoIndex = catIndex + direccion;
  if (nuevoIndex < 0 || nuevoIndex >= catalogoData.categorias.length) return;

  const temp = catalogoData.categorias[catIndex];
  catalogoData.categorias[catIndex] = catalogoData.categorias[nuevoIndex];
  catalogoData.categorias[nuevoIndex] = temp;

  categoriaActivaIndex = nuevoIndex;
  renderizarCatalogo();
  sincronizarCambiosConGitHub(`Reordenar categorías`);
}

// Descargar Respaldo JSON Local
function descargarRespaldoCatalogoJSON() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(catalogoData, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `catalog_backup_${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  mostrarToast('Respaldo descargado exitosamente.');
}

// ==========================================================================
// 12. CONFIGURACIÓN Y EDICIÓN DE PRODUCTOS (ADMIN)
// ==========================================================================

function abrirModalNuevoProducto(catIndex) {
  productoEnEdicion = { catIndex, prodIndex: -1, esNuevo: true };

  document.getElementById('modalTituloEditorProd').innerText = `➕ Nuevo Producto en "${catalogoData.categorias[catIndex].nombre}"`;
  document.getElementById('editProdNombre').value = '';
  document.getElementById('editProdPrecio').value = '0.00';
  document.getElementById('editProdTipoUnidad').value = 'unidades';
  document.getElementById('editProdMinimo').value = '1';
  document.getElementById('editProdPesoAprox').value = '0';
  document.getElementById('editProdPLU').value = '';
  document.getElementById('editProdDisponible').checked = true;
  document.getElementById('editProdFileImg').value = '';

  llenarSelectorCategoriasDestino(catIndex);
  alternarCamposTipoUnidadAdmin('unidades');

  const preview = document.getElementById('previewImgEditor');
  if (preview) {
    preview.src = 'img/LOGO-MUNDO123.webp';
    delete preview.dataset.nuevaImagenWebp;
  }

  const modal = new bootstrap.Modal(document.getElementById('modalEditarProductoAdmin'));
  modal.show();
}

function abrirModalEditor(catIndex, prodIndex) {
  productoEnEdicion = { catIndex, prodIndex, esNuevo: false };
  const prod = catalogoData.categorias[catIndex].productos[prodIndex];
  const [nombre, precio, img, disponible, cantMin, tipoUnidad, pesoAprox, plu] = prod;

  document.getElementById('modalTituloEditorProd').innerText = `⚙️ Configurar: ${nombre}`;
  document.getElementById('editProdNombre').value = nombre || '';
  document.getElementById('editProdPrecio').value = precio || 0;
  document.getElementById('editProdTipoUnidad').value = tipoUnidad || 'unidades';
  document.getElementById('editProdMinimo').value = cantMin || 1;
  document.getElementById('editProdPesoAprox').value = pesoAprox || 0;
  document.getElementById('editProdPLU').value = plu || '';
  document.getElementById('editProdDisponible').checked = disponible === true;
  document.getElementById('editProdFileImg').value = '';

  llenarSelectorCategoriasDestino(catIndex);
  alternarCamposTipoUnidadAdmin(tipoUnidad || 'unidades');

  const preview = document.getElementById('previewImgEditor');
  if (preview) {
    preview.src = img || 'img/LOGO-MUNDO123.webp';
    delete preview.dataset.nuevaImagenWebp;
  }

  const modal = new bootstrap.Modal(document.getElementById('modalEditarProductoAdmin'));
  modal.show();
}

function llenarSelectorCategoriasDestino(catIndexActual) {
  const selectCat = document.getElementById('editProdCategoriaDestino');
  if (!selectCat) return;

  selectCat.innerHTML = '';
  catalogoData.categorias.forEach((c, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.innerText = c.nombre;
    if (idx === catIndexActual) opt.selected = true;
    selectCat.appendChild(opt);
  });
}

function alternarCamposTipoUnidadAdmin(tipo) {
  const contPesoAprox = document.getElementById('contEditPesoAprox');
  const labelMinimo = document.getElementById('labelEditMinimo');

  if (tipo === 'mixto') {
    if (contPesoAprox) contPesoAprox.classList.remove('hidden');
    if (labelMinimo) labelMinimo.innerText = 'Cantidad Mínima (unidades):';
  } else if (tipo === 'gramos') {
    if (contPesoAprox) contPesoAprox.classList.add('hidden');
    if (labelMinimo) labelMinimo.innerText = 'Cantidad Mínima (gramos):';
  } else {
    if (contPesoAprox) contPesoAprox.classList.add('hidden');
    if (labelMinimo) labelMinimo.innerText = 'Cantidad Mínima (unidades):';
  }
}

// Reordenar producto
async function moverPosicionProducto(catIndex, prodIndex, direccion) {
  const nuevoIndex = prodIndex + direccion;
  const lista = catalogoData.categorias[catIndex].productos;

  if (nuevoIndex < 0 || nuevoIndex >= lista.length) return;

  const temp = lista[prodIndex];
  lista[prodIndex] = lista[nuevoIndex];
  lista[nuevoIndex] = temp;

  renderizarCatalogo();
  await sincronizarCambiosConGitHub('Reordenar productos en catálogo');
}

// Eliminar producto
async function eliminarProductoAdmin(catIndex, prodIndex) {
  const prod = catalogoData.categorias[catIndex].productos[prodIndex];
  const confirmar = confirm(`¿Está seguro de eliminar "${prod[0]}" del catálogo?`);
  if (!confirmar) return;

  catalogoData.categorias[catIndex].productos.splice(prodIndex, 1);
  renderizarCatalogo();
  await sincronizarCambiosConGitHub(`Eliminar producto ${prod[0]}`);
}

// Conversor de Imagen a WebP (<120 KB)
async function procesarImagenSeleccionada(event) {
  const file = event.target.files[0];
  if (!file) return;

  try {
    const webpBase64 = await convertirArchivoAWebP(file, 800, 0.85);
    const preview = document.getElementById('previewImgEditor');
    if (preview) {
      preview.src = webpBase64;
      preview.dataset.nuevaImagenWebp = webpBase64;
    }
  } catch (error) {
    console.error('Error procesando imagen WebP:', error);
    mostrarToast('Error al procesar la imagen seleccionada.');
  }
}

function convertirArchivoAWebP(file, maxDimension = 800, calidad = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (readerEvent) => {
      const img = new Image();
      img.src = readerEvent.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/webp', calidad);
        resolve(dataUrl);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}

// Guardar y Aplicar Cambios del Producto
async function guardarCambiosProductoAdmin() {
  if (!productoEnEdicion) return;

  const { catIndex, prodIndex, esNuevo } = productoEnEdicion;
  const selectCat = document.getElementById('editProdCategoriaDestino');
  const catDestinoIndex = selectCat ? parseInt(selectCat.value) : catIndex;

  const nombre = document.getElementById('editProdNombre').value.trim().toUpperCase();
  const precio = parseFloat(document.getElementById('editProdPrecio').value) || 0;
  const tipoUnidad = document.getElementById('editProdTipoUnidad').value;
  const cantMin = parseFloat(document.getElementById('editProdMinimo').value) || 1;
  const pesoAprox = parseFloat(document.getElementById('editProdPesoAprox').value) || 0;
  const plu = document.getElementById('editProdPLU').value.trim();
  const disponible = document.getElementById('editProdDisponible').checked;

  if (!nombre) {
    mostrarToast('El nombre del producto es obligatorio.');
    return;
  }

  let rutaImagenFinal = 'img/LOGO-MUNDO123.webp';

  if (!esNuevo) {
    rutaImagenFinal = catalogoData.categorias[catIndex].productos[prodIndex][2];
  }

  const preview = document.getElementById('previewImgEditor');
  if (preview && preview.dataset.nuevaImagenWebp) {
    const nombreArchivoLimpio = nombre.toLowerCase().replace(/[^a-z0-9]/g, '_') + '.webp';
    rutaImagenFinal = `img/${nombreArchivoLimpio}`;
    await subirImagenAGitHub(rutaImagenFinal, preview.dataset.nuevaImagenWebp);
    delete preview.dataset.nuevaImagenWebp;
  }

  const nuevoArregloProducto = [
    nombre,
    precio,
    rutaImagenFinal,
    disponible,
    cantMin,
    tipoUnidad,
    pesoAprox,
    plu
  ];

  if (esNuevo) {
    catalogoData.categorias[catDestinoIndex].productos.push(nuevoArregloProducto);
  } else {
    // Si cambió de categoría, moverlo
    if (catDestinoIndex !== catIndex) {
      catalogoData.categorias[catIndex].productos.splice(prodIndex, 1);
      catalogoData.categorias[catDestinoIndex].productos.push(nuevoArregloProducto);
    } else {
      catalogoData.categorias[catIndex].productos[prodIndex] = nuevoArregloProducto;
    }
  }

  const modalEl = document.getElementById('modalEditarProductoAdmin');
  const modalInstance = bootstrap.Modal.getInstance(modalEl);
  if (modalInstance) modalInstance.hide();

  categoriaActivaIndex = catDestinoIndex;
  renderizarCatalogo();
  await sincronizarCambiosConGitHub(`Actualizar producto ${nombre}`);
}

// ==========================================================================
// 13. API REST DE GITHUB (COMMITS AUTOMÁTICOS & SUBIDA DE WEBP)
// ==========================================================================

function solicitarTokenGitHubSiFalta() {
  if (githubTokenAdmin && (githubTokenAdmin.startsWith('ghp_') || githubTokenAdmin.startsWith('github_pat_'))) {
    return true;
  }
  const modalEl = document.getElementById('modalEscanearTokenGitHub');
  if (modalEl) {
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  }
  return false;
}

function validarYGuardarTokenQR() {
  const input = document.getElementById('inputTokenQR');
  if (!input) return;

  const token = input.value.trim();
  if (!token) return;

  githubTokenAdmin = token;
  localStorage.setItem('mundocarnes_gh_token', token);

  const modalEl = document.getElementById('modalEscanearTokenGitHub');
  const modalInstance = bootstrap.Modal.getInstance(modalEl);
  if (modalInstance) modalInstance.hide();

  mostrarToast('Token de GitHub guardado exitosamente.');
  sincronizarCambiosConGitHub('Sincronización autorizada');
}

async function sincronizarCambiosConGitHub(mensajeCommit = 'Actualizar catálogo') {
  if (!solicitarTokenGitHubSiFalta()) return;

  mostrarToast('Sincronizando catálogo con GitHub... ⏳');

  try {
    const urlGet = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_CATALOG_PATH}?ref=${GITHUB_BRANCH}`;
    const resGet = await fetch(urlGet, {
      headers: {
        'Authorization': `token ${githubTokenAdmin}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    let currentSha = '';
    if (resGet.ok) {
      const dataGet = await resGet.json();
      currentSha = dataGet.sha;
    }

    const jsonString = JSON.stringify(catalogoData, null, 2);
    const contentBase64 = b64EncodeUnicode(jsonString);

    const urlPut = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_CATALOG_PATH}`;
    const resPut = await fetch(urlPut, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${githubTokenAdmin}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: `[Editor] ${mensajeCommit}`,
        content: contentBase64,
        sha: currentSha,
        branch: GITHUB_BRANCH
      })
    });

    if (!resPut.ok) {
      const errData = await resPut.json();
      throw new Error(errData.message || 'Error al enviar commit a GitHub');
    }

    mostrarToast('✅ ¡Catálogo sincronizado exitosamente con GitHub!');
  } catch (error) {
    console.error('Error sincronizando con GitHub:', error);
    mostrarToast(`Error al sincronizar con GitHub: ${error.message}`);
  }
}

async function subirImagenAGitHub(rutaRelativa, base64DataUrl) {
  if (!solicitarTokenGitHubSiFalta()) return;

  try {
    const base64Content = base64DataUrl.split(',')[1];
    const urlGet = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${rutaRelativa}?ref=${GITHUB_BRANCH}`;

    let currentSha = '';
    const resGet = await fetch(urlGet, {
      headers: {
        'Authorization': `token ${githubTokenAdmin}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (resGet.ok) {
      const dataGet = await resGet.json();
      currentSha = dataGet.sha;
    }

    const urlPut = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${rutaRelativa}`;
    const bodyPayload = {
      message: `[Editor] Subir imagen WebP ${rutaRelativa}`,
      content: base64Content,
      branch: GITHUB_BRANCH
    };
    if (currentSha) bodyPayload.sha = currentSha;

    const resPut = await fetch(urlPut, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${githubTokenAdmin}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bodyPayload)
    });

    if (!resPut.ok) {
      console.warn('Aviso al subir imagen a GitHub:', await resPut.text());
    }
  } catch (err) {
    console.error('Error subiendo imagen WebP a GitHub:', err);
  }
}

// Codificadores Base64 compatibles con UTF-8
function b64EncodeUnicode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(match, p1) {
    return String.fromCharCode('0x' + p1);
  }));
}

function b64DecodeUnicode(str) {
  return decodeURIComponent(Array.prototype.map.call(atob(str), function(c) {
    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));
}

// ==========================================================================
// 14. SISTEMA DE NOTIFICACIONES TOAST
// ==========================================================================

function mostrarToast(mensaje) {
  const toastEl = document.getElementById('toastGenerico') || document.getElementById('toastFactura');
  const msgEl = document.getElementById('toastMensaje') || document.getElementById('toastMensajeFactura');
  if (toastEl && msgEl) {
    msgEl.innerText = mensaje;
    const toast = new bootstrap.Toast(toastEl, { delay: 3500 });
    toast.show();
  } else {
    console.log('[Toast]:', mensaje);
  }
}
