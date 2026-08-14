/* ==========================================================================
   Lógica del Frontend e Interacción Optimizada - Mundocarnes
   Catálogo Abierto (Todas las Secciones Visibles), Grid 3/6 y Carrito Flotante
   ========================================================================== */

const GITHUB_CONFIG = {
  owner: "gilkerosales-boop",
  repo: "mundocarnes",
  branch: "main"
};

// Configuración de Supabase
const SUPABASE_URL = "https://bdhlgiygrozdebhmwyds.supabase.co";
const SUPABASE_KEY = "sb_publishable_qA5isaOYl_QZzB_WiZsIPA_zjWnTO_6";
let supabaseClient = null;

if (window.supabase && typeof window.supabase.createClient === "function") {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

let carrito = {};
let productoTemporal = {};
let productoZoomActivo = null;
let cacheUsuario = { cedula: "", nombre: "", apellido: "", telefono: "", rol: "" };
let datosCheckout = { ubicacion: "", formaPago: "" };
let cacheCategorias = []; 
let iti;
let itiCheckout;
let isZoomStatePushed = false;

// Inicializador seguro de cliente Supabase
function getSupabase() {
  if (!supabaseClient && window.supabase && typeof window.supabase.createClient === "function") {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return supabaseClient;
}

// Actualizar Contador en el Botón Flotante "Ver Pedido"
function actualizarContadorCarrito() {
  const badge = document.getElementById('badgeCantCarrito');
  if (badge) {
    const totalItems = Object.keys(carrito).length;
    badge.textContent = totalItems;
  }
}

// Subida directa de archivos a GitHub vía API REST
async function subirArchivoAGitHub(path, contentBase64, commitMessage) {
  const token = sessionStorage.getItem("github_token");
  if (!token) throw new Error("Sesión administrativa no válida o expirada.");

  const url = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${path}`;

  let sha = null;
  try {
    const resInfo = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (resInfo.ok) {
      const info = await resInfo.json();
      sha = info.sha;
    }
  } catch (e) {}

  const body = {
    message: commitMessage,
    content: contentBase64,
    branch: GITHUB_CONFIG.branch
  };
  if (sha) body.sha = sha;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errData = await response.json();
    throw new Error(errData.message || "Fallo en la comunicación con GitHub.");
  }
  return await response.json();
}

// Sincronizar Catálogo JSON completo con GitHub
async function guardarCatalogoEnGitHub() {
  const contentString = JSON.stringify({ categorias: cacheCategorias }, null, 2);
  const base64Content = btoa(unescape(encodeURIComponent(contentString)));
  await subirArchivoAGitHub("catalog.json", base64Content, "Sincronización automática de catálogo desde el Modo Editor");
}

// Lectura e inspección de imágenes WebP < 120 KB
function validarYLeerArchivoWebP(fileElement) {
  return new Promise((resolve, reject) => {
    const file = fileElement.files[0];
    if (!file) {
      resolve(null);
      return;
    }

    const esWebP = file.type === "image/webp" || file.name.toLowerCase().endsWith(".webp");
    if (!esWebP) {
      reject("La imagen no cumple con el formato exigido. Debe ser .webp");
      return;
    }

    const limitePeso = 120 * 1024;
    if (file.size > limitePeso) {
      reject("La imagen no cumple con el tamaño exigido. Debe pesar menos de 120 KB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
      const base64 = e.target.result.split(",")[1];
      const safeName = file.name.replace(/\s+/g, "_").toLowerCase();
      resolve({ base64: base64, name: safeName });
    };
    reader.onerror = function() {
      reject("Error al leer el archivo físico.");
    };
    reader.readAsDataURL(file);
  });
}

// Validador de Teléfonos Venezuela (+58)
function validarTelefonoVenezuela(itiInstance) {
  if (!itiInstance) return false;
  const countryData = itiInstance.getSelectedCountryData();
  const rawNumber = itiInstance.getNumber();
  
  if (countryData.dialCode === "58") {
    const digitos = rawNumber.replace(/\D/g, "");
    if (digitos.length === 12 && digitos.startsWith("584")) {
      const prefijoCelular = digitos.substring(2, 5);
      const prefijosValidos = ["412", "422", "414", "424", "416", "426"];
      if (prefijosValidos.includes(prefijoCelular)) return true;
    }
  }
  return itiInstance.isValidNumber();
}

function mostrarAviso(mensaje) {
  try { 
    document.getElementById('toastMensaje').textContent = mensaje; 
    bootstrap.Toast.getOrCreateInstance(document.getElementById('liveToast')).show();
  } catch(e) { 
    alert(mensaje); 
  }
}

function regresarAlInicio() {
  cacheUsuario = { cedula: "", nombre: "", apellido: "", telefono: "", rol: "" }; 
  carrito = {}; 
  cacheCategorias = [];
  actualizarContadorCarrito();
  
  document.getElementById('cedula').value = ""; 
  document.getElementById('passwordAdmin').value = "";
  document.getElementById('regNombre').value = ""; 
  document.getElementById('regApellido').value = "";
  
  if (iti) iti.setNumber(""); 
  if (itiCheckout) itiCheckout.setNumber("");

  document.getElementById('vistaAdminPassword').classList.add('hidden'); 
  document.getElementById('vistaRegistro').classList.add('hidden');
  document.getElementById('vistaPedido').classList.add('hidden'); 
  document.getElementById('vistaIngreso').classList.add('hidden');
  
  document.getElementById('btnAdminPanel').classList.add('hidden');
  document.getElementById('btnVerPedido').classList.remove('hidden');
  document.getElementById('btnSesionHeader').classList.add('hidden');
  document.getElementById('saludoUsuario').innerHTML = "¡Bienvenido a <strong>Mundocarnes</strong>! 🥩";

  if (window.location.search.includes('admin') || window.location.hash === "#admin") {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  document.getElementById('vistaCombos').classList.remove('hidden');

  fetch("catalog.json?t=" + new Date().getTime())
    .then(res => res.json())
    .then(renderizarCatalogo);
}

function controlarSesionHeader() {
  if (cacheUsuario.cedula || cacheUsuario.rol === "ADMIN") {
    regresarAlInicio();
  } else {
    irALoginAdministrador();
  }
}

function irALoginAdministrador() {
  document.getElementById('vistaCombos').classList.add('hidden');
  document.getElementById('vistaIngreso').classList.remove('hidden');
  document.getElementById('btnVerPedido').classList.add('hidden');
  document.getElementById('cedula').placeholder = "Ingrese Cédula o RIF";
}

async function procesarPrimerPaso() {
  const cedulaInput = document.getElementById('cedula').value.trim().toUpperCase();
  if (!cedulaInput) { mostrarAviso("Introduzca su Cédula o RIF."); return; }
  
  const btn = document.getElementById('btnSiguiente'); 
  btn.disabled = true; 
  btn.textContent = "Verificando...";
  
  try {
    const sb = getSupabase();
    if (!sb) throw new Error("Servicio de base de datos no disponible.");

    // 1. Verificar si es administrador
    const { data: adminData, error: adminErr } = await sb
      .from('administradores')
      .select('"CEDULA", "NOMBRE", "APELLIDO"')
      .eq('CEDULA', cedulaInput)
      .maybeSingle();

    if (adminData && !adminErr) {
      btn.disabled = false; 
      btn.textContent = "Siguiente";
      cacheUsuario.cedula = cedulaInput;
      cacheUsuario.nombre = adminData.NOMBRE || "ADMINISTRADOR";
      cacheUsuario.apellido = adminData.APELLIDO || "";
      document.getElementById('saludoAdmin').textContent = `Bienvenido: ${adminData.NOMBRE} ${adminData.APELLIDO || ''}`;
      document.getElementById('vistaIngreso').classList.add('hidden'); 
      document.getElementById('vistaAdminPassword').classList.remove('hidden');
      return;
    }

    // 2. Verificar si es cliente registrado
    const { data: clienteData, error: cliErr } = await sb
      .from('clientes')
      .select('"CEDULA", "NOMBRES", "APELLIDOS", "TELEFONO", "DIRECCION"')
      .eq('CEDULA', cedulaInput)
      .maybeSingle();

    btn.disabled = false; 
    btn.textContent = "Siguiente";

    cacheUsuario.cedula = cedulaInput;

    if (clienteData && !cliErr) {
      cacheUsuario.nombre = clienteData.NOMBRES || "";
      cacheUsuario.apellido = clienteData.APELLIDOS || "";
      cacheUsuario.telefono = clienteData.TELEFONO || "";
      cacheUsuario.rol = "CLIENTE";
      concederAccesoAlSistema();
    } else {
      document.getElementById('vistaIngreso').classList.add('hidden'); 
      document.getElementById('vistaRegistro').classList.remove('hidden');
    }

  } catch (err) {
    btn.disabled = false; 
    btn.textContent = "Siguiente";
    console.error("Error al consultar Supabase:", err);
    mostrarAviso("Error de conexión al verificar cédula.");
  }
}

async function verificarPasswordAdministrador() {
  const token = document.getElementById('passwordAdmin').value.trim();
  if (!token) return mostrarAviso("Por favor, ingrese su Token.");
  
  const btn = document.getElementById('btnAdminIngreso'); 
  btn.disabled = true;
  btn.textContent = "Validando Token...";

  try {
    const url = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}`;
    const response = await fetch(url, {
      headers: { 
        "Authorization": `Bearer ${token}`, 
        "Accept": "application/vnd.github+json"
      }
    });
    
    if (response.ok) {
      const repoData = await response.json();
      if (repoData.permissions && repoData.permissions.push) {
        sessionStorage.setItem("github_token", token);
        cacheUsuario.rol = "ADMIN";
        concederAccesoAlSistema();
      } else {
        mostrarAviso("El token no cuenta con permisos de escritura (push) en este repositorio.");
      }
    } else {
      mostrarAviso("Token inválido o repositorio inaccesible.");
    }
  } catch (error) {
    console.error("Error en validación:", error);
    mostrarAviso("Error al validar credenciales.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema";
  }
}

async function ejecutarRegistroNuevoCliente() {
  const nom = document.getElementById('regNombre').value.trim().toUpperCase();
  const ape = document.getElementById('regApellido').value.trim().toUpperCase();
  
  if (!nom || !ape) return mostrarAviso("Llene todos los campos.");
  
  let tel = "";
  if (iti) {
    if (!validarTelefonoVenezuela(iti)) {
      return mostrarAviso("Por favor, introduzca un número celular válido de Venezuela.");
    }
    tel = iti.getNumber();
  } else {
    tel = document.getElementById('regTelefono').value.trim();
    if (!tel) return mostrarAviso("Llene todos los campos.");
  }
  
  const btn = document.getElementById('btnRegistrar'); 
  btn.disabled = true; 
  btn.textContent = "Registrando...";
  
  try {
    const sb = getSupabase();
    if (!sb) throw new Error("Servicio de base de datos no disponible.");

    const { error } = await sb
      .from('clientes')
      .upsert({
        "CEDULA": cacheUsuario.cedula,
        "NOMBRES": nom,
        "APELLIDOS": ape,
        "TELEFONO": tel,
        "DIRECCION": null
      });

    btn.disabled = false; 
    btn.textContent = "Registrar y Comprar";

    if (error) {
      console.error("Error Supabase registro:", error);
      return mostrarAviso("Error al guardar cliente en la base de datos.");
    }

    cacheUsuario.nombre = nom; 
    cacheUsuario.apellido = ape; 
    cacheUsuario.telefono = tel; 
    cacheUsuario.rol = "CLIENTE";
    concederAccesoAlSistema();

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Registrar y Comprar";
    console.error(err);
    mostrarAviso("Error de conexión al registrar cliente.");
  }
}

function concederAccesoAlSistema() {
  document.getElementById('vistaIngreso').classList.add('hidden'); 
  document.getElementById('vistaAdminPassword').classList.add('hidden');
  document.getElementById('vistaRegistro').classList.add('hidden'); 
  document.getElementById('vistaCombos').classList.remove('hidden');

  if (cacheUsuario.rol === "ADMIN") {
    document.getElementById('saludoUsuario').innerHTML = `⚙️ <strong>Modo Editor:</strong> ${cacheUsuario.nombre}`;
    document.getElementById('btnVerPedido').classList.add('hidden'); 
    document.getElementById('btnAdminPanel').classList.remove('hidden'); 
    document.getElementById('btnSesionHeader').textContent = "Cerrar Sesión 🚪";
  } else {
    document.getElementById('saludoUsuario').innerHTML = `👋 Hola, <strong>${cacheUsuario.nombre}</strong>`;
    document.getElementById('btnVerPedido').classList.remove('hidden');
    document.getElementById('btnAdminPanel').classList.add('hidden'); 
    document.getElementById('btnSesionHeader').textContent = "Cerrar Sesión 🚪";
  }
  
  fetch("catalog.json?t=" + new Date().getTime())
    .then(res => res.json())
    .then(renderizarCatalogo)
    .catch(err => {
      console.error(err);
      mostrarAviso("Error al obtener catalog.json desde el servidor.");
    });
}

// Renderizado con Todas las Secciones Abiertas y Visibles Continuamente
function renderizarCatalogo(resp) {
  if (resp.error) return alert(resp.error);
  
  cacheCategorias = resp.categorias || [];
  let navPillsHtml = "";
  let sectionsHtml = "";
  
  cacheCategorias.forEach((cat) => {
    let safeId = "cat-" + cat.nombre.replace(/\s+/g, '-').toLowerCase();
    
    // Botones píldora para salto suave a cada sección
    navPillsHtml += `
      <a href="#${safeId}" class="btn-nav-categoria">${cat.nombre}</a>`;
    
    // Sección visible completa con su título y grid de productos
    sectionsHtml += `
      <section class="seccion-categoria" id="${safeId}">
        <h4 class="titulo-seccion-categoria">${cat.nombre}</h4>
        <div id="lista-${safeId}" class="row g-2"></div>
      </section>`;
  });
  
  document.getElementById('catalogoTabs').innerHTML = navPillsHtml;
  document.getElementById('catalogoTabContent').innerHTML = sectionsHtml;
  
  cacheCategorias.forEach((cat) => {
    let safeId = "cat-" + cat.nombre.replace(/\s+/g, '-').toLowerCase();
    let idElemento = "lista-" + safeId;
    cargarLista(idElemento, cat.productos, cat.nombre);
  });
}

// Cargar Lista con Grid de 3 Columnas en Móviles y 6 Columnas en Escritorio
function cargarLista(idElemento, datos, nombreCategoria) {
  const contenedor = document.getElementById(idElemento);
  if (!contenedor) return;

  contenedor.innerHTML = datos.map(f => {
    let esDisp = f[3]; 
    let cantMin = f[4]; 
    let unidad = f[5]; 
    let pesoProm = f[6] || 0;
    let codigoBalanza = f[7] || "";

    let claseImg = esDisp ? "" : "img-agotado";
    let etiquetaDisp = esDisp ? "" : `<span class="badge bg-danger position-absolute top-0 start-0 m-1">Agotado</span>`;
    let boton = "";
    
    if (cacheUsuario.rol === "ADMIN") {
      boton = `<button class="btn btn-sm btn-warning fw-bold mt-1 w-100" onclick="abrirModalEdicion('${f[0]}', '${f[1]}', '${nombreCategoria}', ${esDisp}, ${cantMin}, '${unidad}', ${pesoProm}, '${codigoBalanza}')">Editar ⚙️</button>`;
    } else {
      if (esDisp) boton = `<button class="btn btn-sm btn-outline-dark fw-bold mt-1 w-100" onclick="seleccionarProducto('${f[0]}', '${f[1]}', '${nombreCategoria}', ${cantMin}, '${unidad}', ${pesoProm})">+ Pedir</button>`;
      else boton = `<button class="btn btn-sm btn-secondary fw-bold mt-1 w-100" disabled>Agotado</button>`;
    }
    
    let unidadTxt = (unidad === 'gramos') ? 'g' : 'uds';

    // Grid: col-4 (3 columnas en móvil), col-md-3 (4 en tablet), col-lg-2 (6 en PC)
    return `
      <div class="col-4 col-md-3 col-lg-2">
        <div class="card h-100 position-relative">
          ${etiquetaDisp}
          <img src="${f[2]}" loading="lazy" decoding="async" class="card-img-top ${claseImg}" onclick="mostrarImagenGrande('${f[2]}', '${f[0]}', '${f[1]}', '${nombreCategoria}', ${cantMin}, '${unidad}', ${pesoProm})">
          <h6 class="fw-bold text-truncate">${f[0]}</h6>
          <p class="text-success fw-bold">$${f[1]}</p>
          <small class="text-muted">Mín: ${cantMin}${unidadTxt}</small>
          ${boton}
        </div>
      </div>`;
  }).join('');
}

// Abrir Modal de Edición del Administrador
function abrirModalEdicion(nom, prec, cat, disp, min, unidad, pesoProm = 0, codigoBalanza = "") {
  productoTemporal = { nombre: nom, categoria: cat };
  
  document.getElementById('editProductoNuevoNombre').value = nom; 
  document.getElementById('editProductoCategoria').textContent = cat;
  document.getElementById('editProductoPrecio').value = prec;
  document.getElementById('editProductoDisponible').value = disp ? "true" : "false";
  document.getElementById('editProductoMinimo').value = min;
  
  const selUnidad = document.getElementById('editProductoUnidad');
  selUnidad.value = unidad || "unidades";
  
  const inputPesoProm = document.getElementById('editProductoPesoPromedio');
  if (inputPesoProm) {
    inputPesoProm.value = pesoProm || "";
  }
  alternarCampoPesoPromedio(unidad || "unidades");

  // Asignar Código PLU privado
  const inputCodigo = document.getElementById('editProductoCodigo');
  if (inputCodigo) {
    inputCodigo.value = codigoBalanza || "";
  }

  document.getElementById('editProductoArchivoImagen').value = "";
  
  let catObj = cacheCategorias.find(c => c.nombre === cat);
  if (catObj) {
    const index = catObj.productos.findIndex(p => p[0] === nom);
    const posicionActual = index + 1;
    const totalProductos = catObj.productos.length;
    
    const posInput = document.getElementById('editProductoPosicion');
    posInput.value = posicionActual;
    posInput.max = totalProductos;
    
    document.getElementById('editProductoPosicionAyuda').textContent = 
      `Posición actual: ${posicionActual} de ${totalProductos} productos en esta categoría.`;
  }
  
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEditarProducto')).show();
}

function alternarCampoPesoPromedio(val) {
  const cont = document.getElementById('contenedorEditPesoPromedio');
  if (cont) {
    if (val === 'mixto') cont.classList.remove('hidden');
    else cont.classList.add('hidden');
  }
}
window.alternarCampoPesoPromedio = alternarCampoPesoPromedio;

// Guardar Edición del Administrador
async function guardarEdicionAdministrador() {
  const nuevoNombre = document.getElementById('editProductoNuevoNombre').value.trim();
  const prec = parseFloat(document.getElementById('editProductoPrecio').value);
  const disp = document.getElementById('editProductoDisponible').value === "true";
  const min = parseInt(document.getElementById('editProductoMinimo').value);
  const unidad = document.getElementById('editProductoUnidad').value;
  const pesoProm = unidad === "mixto" ? parseInt(document.getElementById('editProductoPesoPromedio').value) : 0;
  const nuevoCodigo = document.getElementById('editProductoCodigo').value.trim();
  const nuevaPosicion = parseInt(document.getElementById('editProductoPosicion').value);
  
  if (!nuevoNombre || isNaN(prec) || isNaN(min) || !unidad || isNaN(nuevaPosicion) || (unidad === "mixto" && (!pesoProm || pesoProm <= 0))) {
    return mostrarAviso("Llene todos los campos de forma correcta.");
  }
  
  const modalEl = document.getElementById('modalEditarProducto');
  const btn = modalEl.querySelector(".btn-warning");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  try {
    const imgData = await validarYLeerArchivoWebP(document.getElementById('editProductoArchivoImagen'));
    let relativeImgPath = null;

    if (imgData) {
      const filePath = `img/${imgData.name}`;
      await subirArchivoAGitHub(filePath, imgData.base64, `Subida de imagen de producto: ${imgData.name}`);
      relativeImgPath = filePath;
    }

    let cat = cacheCategorias.find(c => c.nombre === productoTemporal.categoria);
    if (cat) {
      const oldIndex = cat.productos.findIndex(p => p[0] === productoTemporal.nombre);
      if (oldIndex !== -1) {
        let prod = cat.productos[oldIndex];
        
        prod[0] = nuevoNombre;
        prod[1] = prec;
        prod[3] = disp;
        prod[4] = min;
        prod[5] = unidad;
        prod[6] = pesoProm;
        prod[7] = nuevoCodigo;

        if (relativeImgPath) {
          prod[2] = relativeImgPath;
        }
        
        let targetIndex = nuevaPosicion - 1;
        if (targetIndex < 0) targetIndex = 0;
        if (targetIndex >= cat.productos.length) targetIndex = cat.productos.length - 1;
        
        if (oldIndex !== targetIndex) {
          cat.productos.splice(oldIndex, 1);
          cat.productos.splice(targetIndex, 0, prod);
        }
      }
    }

    await guardarCatalogoEnGitHub();

    btn.disabled = false;
    btn.textContent = "Guardar Cambios 💾";
    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    mostrarAviso("Producto guardado correctamente.");
    
    renderizarCatalogo({ categorias: cacheCategorias });

  } catch (error) {
    btn.disabled = false;
    btn.textContent = "Guardar Cambios 💾";
    alert("Error de guardado: " + error);
  }
}

function seleccionarProducto(nom, prec, tipo, cantMin, unidad, pesoPromedio = 0) {
  productoTemporal = { nombre: nom, precio: prec, tipo: tipo, minBase: cantMin, unidad: unidad, pesoPromedio: pesoPromedio };
  document.getElementById('nombreProductoModal').textContent = nom;
  
  const contUnidades = document.getElementById('contenedorUnidades');
  const contPeso = document.getElementById('contenedorPeso');
  const errorDiv = document.getElementById('errorModalCantidad');
  
  document.getElementById('inputCantidad').classList.remove('is-invalid');
  document.getElementById('inputKg').classList.remove('is-invalid');
  document.getElementById('inputGramos').classList.remove('is-invalid');
  errorDiv.classList.add('hidden');
  
  if (unidad === 'unidades' || unidad === 'mixto') {
    contUnidades.classList.remove('hidden');
    contPeso.classList.add('hidden');
    
    let inp = document.getElementById('inputCantidad');
    inp.min = cantMin; 
    inp.value = cantMin;
  } else {
    contUnidades.classList.add('hidden');
    contPeso.classList.remove('hidden');
    
    document.getElementById('inputKg').value = "";
    document.getElementById('inputGramos').value = "";
  }
  
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCantidad')).show();
}

function confirmarSeleccion() {
  const errorDiv = document.getElementById('errorModalCantidad');
  
  if (productoTemporal.unidad === 'unidades' || productoTemporal.unidad === 'mixto') {
    const inputCant = document.getElementById('inputCantidad');
    let cant = parseInt(inputCant.value);
    
    if (isNaN(cant) || cant < productoTemporal.minBase) {
      inputCant.classList.add('is-invalid');
      errorDiv.textContent = `Por favor, indique la cantidad deseada. El mínimo es de ${productoTemporal.minBase} uds.`;
      errorDiv.classList.remove('hidden');
      return;
    }
    
    inputCant.classList.remove('is-invalid');
    errorDiv.classList.add('hidden');
    
    let calc = 0;
    let cantTxt = cant + ' uds';

    if (productoTemporal.unidad === 'mixto') {
      let totalGramos = cant * (productoTemporal.pesoPromedio || 0);
      calc = (productoTemporal.precio / 1000) * totalGramos;
      let kgEnteros = Math.floor(totalGramos / 1000);
      let gRestantes = totalGramos % 1000;
      let pesoTxt = kgEnteros > 0 ? (gRestantes > 0 ? `${kgEnteros}Kg ${gRestantes}g` : `${kgEnteros}Kg`) : `${gRestantes}g`;
      cantTxt = `${cant} uds (~${pesoTxt})`;
    } else {
      calc = productoTemporal.precio * cant;
    }
    
    carrito[productoTemporal.nombre] = { 
      cantidad: cantTxt, 
      precio: calc.toFixed(2), 
      cantNumerica: cant, 
      tipo: productoTemporal.tipo, 
      unidad: productoTemporal.unidad,
      precioBase: productoTemporal.precio, 
      minBase: productoTemporal.minBase,
      pesoPromedio: productoTemporal.pesoPromedio || 0
    };
  } else {
    const kgInput = document.getElementById('inputKg');
    const gInput = document.getElementById('inputGramos');
    
    const kgVal = parseFloat(kgInput.value) || 0;
    const gVal = parseFloat(gInput.value) || 0;
    const totalGramos = (kgVal * 1000) + gVal;
    
    const ambosVacios = (kgInput.value.trim() === "" && gInput.value.trim() === "");
    if (ambosVacios || totalGramos < productoTemporal.minBase) {
      kgInput.classList.add('is-invalid');
      gInput.classList.add('is-invalid');
      errorDiv.textContent = `Por favor, indique el peso deseado para su producto. El peso total debe ser de al menos ${productoTemporal.minBase}g.`;
      errorDiv.classList.remove('hidden');
      return;
    }
    
    kgInput.classList.remove('is-invalid');
    gInput.classList.remove('is-invalid');
    errorDiv.classList.add('hidden');
    
    let calc = (productoTemporal.precio / 1000) * totalGramos;
    
    let cantidadTxt = "";
    const kgEnteros = Math.floor(totalGramos / 1000);
    const gramosRestantes = totalGramos % 1000;
    if (kgEnteros > 0) {
      cantidadTxt += `${kgEnteros} Kg`;
      if (gramosRestantes > 0) cantidadTxt += ` ${gramosRestantes} g`;
    } else {
      cantidadTxt += `${gramosRestantes} g`;
    }
    
    carrito[productoTemporal.nombre] = { 
      cantidad: cantidadTxt, 
      precio: calc.toFixed(2), 
      cantNumerica: totalGramos, 
      tipo: productoTemporal.tipo, 
      unidad: productoTemporal.unidad,
      precioBase: productoTemporal.precio, 
      minBase: productoTemporal.minBase,
      pesoPromedio: 0
    };
  }
  
  actualizarContadorCarrito();
  mostrarAviso(`Agregado: ${productoTemporal.nombre}`);
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCantidad')).hide();
}

function mostrarPedido() {
  document.getElementById('vistaCombos').classList.add('hidden'); 
  document.getElementById('vistaPedido').classList.remove('hidden');
  document.getElementById('btnVerPedido').classList.add('hidden');
  
  let html = '<table class="table align-middle"><tbody>'; 
  let t = 0;
  for (let p in carrito) {
    let item = carrito[p]; 
    t += parseFloat(item.precio);
    html += `<tr><td style="max-width: 140px;" class="text-wrap fw-bold">${p}</td><td><input type="number" class="form-control form-control-sm text-center fw-bold border-secondary p-1" value="${item.cantNumerica}" min="${item.minBase}" style="width:70px" onchange="cambiarCantidadInline('${p}', this.value)"></td><td class="text-danger fw-bold text-nowrap">$${item.precio}</td><td><button class="btn btn-sm btn-outline-danger px-2 py-1" onclick="eliminarDelCarrito('${p}')">✕</button></td></tr>`;
  }
  html += `<tr class="table-light fw-bold border-top"><td colspan="2" class="text-end">TOTAL ESTIMADO:</td><td class="text-danger fs-5">$${t.toFixed(2)}</td><td></td></tr></tbody></table>`;
  document.getElementById('listaPedido').innerHTML = Object.keys(carrito).length ? html : '<p class="text-center py-4 text-muted">Tu carrito está vacío.</p>';
}

function cambiarCantidadInline(nombre, nuevaCant) {
  let item = carrito[nombre]; 
  let cant = parseInt(nuevaCant);
  if (isNaN(cant) || cant < item.minBase) { mostrarAviso(`Mínimo requerido: ${item.minBase}`); mostrarPedido(); return; }
  item.cantNumerica = cant; 
  
  if (item.unidad === 'unidades') {
    item.cantidad = cant + ' uds';
    item.precio = (item.precioBase * cant).toFixed(2);
  } else if (item.unidad === 'mixto') {
    let totalGramos = cant * (item.pesoPromedio || 0);
    let kgEnteros = Math.floor(totalGramos / 1000);
    let gRestantes = totalGramos % 1000;
    let pesoTxt = kgEnteros > 0 ? (gRestantes > 0 ? `${kgEnteros}Kg ${gRestantes}g` : `${kgEnteros}Kg`) : `${gRestantes}g`;
    item.cantidad = `${cant} uds (~${pesoTxt})`;
    item.precio = ((item.precioBase / 1000) * totalGramos).toFixed(2);
  } else {
    let cantidadTxt = "";
    const kgEnteros = Math.floor(cant / 1000);
    const gramosRestantes = cant % 1000;
    if (kgEnteros > 0) {
      cantidadTxt += `${kgEnteros} Kg`;
      if (gramosRestantes > 0) cantidadTxt += ` ${gramosRestantes} g`;
    } else {
      cantidadTxt += `${gramosRestantes} g`;
    }
    item.cantidad = cantidadTxt;
    item.precio = ((item.precioBase / 1000) * cant).toFixed(2);
  }
  mostrarPedido();
  actualizarContadorCarrito();
}

function eliminarDelCarrito(p) { 
  delete carrito[p]; 
  mostrarPedido(); 
  actualizarContadorCarrito();
}

function cerrarPedido() { 
  document.getElementById('vistaPedido').classList.add('hidden'); 
  document.getElementById('vistaCombos').classList.remove('hidden'); 
  if (cacheUsuario.rol !== "ADMIN") {
    document.getElementById('btnVerPedido').classList.remove('hidden');
  }
}

function abrirSolicitudPago() {
  if (!Object.keys(carrito).length) return;
  
  if (cacheUsuario.cedula && cacheUsuario.telefono) {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).show();
  } else {
    document.getElementById('checkoutPasoCedula').classList.remove('hidden');
    document.getElementById('checkoutPasoRegistro').classList.add('hidden');
    document.getElementById('checkoutCedula').value = "";
    
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAutenticacionCheckout')).show();
  }
}

async function verificarClienteCheckout() {
  const cedulaInput = document.getElementById('checkoutCedula').value.trim().toUpperCase();
  if (!cedulaInput) return mostrarAviso("Por favor, ingrese su Cédula o RIF.");
  
  const btn = document.getElementById('btnContinuarCheckout');
  btn.disabled = true;
  btn.textContent = "Verificando...";
  
  try {
    const sb = getSupabase();
    if (!sb) throw new Error("Servicio de base de datos no disponible.");

    // Verificar si es Administrador
    const { data: adminData } = await sb
      .from('administradores')
      .select('"CEDULA"')
      .eq('CEDULA', cedulaInput)
      .maybeSingle();

    if (adminData) {
      btn.disabled = false;
      btn.textContent = "Continuar ➡️";
      mostrarAviso("Identificado como administrador. Inicie sesión desde el menú superior.");
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAutenticacionCheckout')).hide();
      irALoginAdministrador();
      return;
    }

    // Verificar si es Cliente
    const { data: clienteData, error: cliErr } = await sb
      .from('clientes')
      .select('"CEDULA", "NOMBRES", "APELLIDOS", "TELEFONO", "DIRECCION"')
      .eq('CEDULA', cedulaInput)
      .maybeSingle();

    btn.disabled = false;
    btn.textContent = "Continuar ➡️";

    cacheUsuario.cedula = cedulaInput;

    if (clienteData && !cliErr) {
      cacheUsuario.nombre = clienteData.NOMBRES || "";
      cacheUsuario.apellido = clienteData.APELLIDOS || "";
      cacheUsuario.telefono = clienteData.TELEFONO || "";
      cacheUsuario.rol = "CLIENTE";
      
      mostrarAviso(`Bienvenido de nuevo, ${clienteData.NOMBRES} 👋`);
      
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAutenticacionCheckout')).hide();
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).show();
    } else {
      document.getElementById('checkoutPasoCedula').classList.add('hidden');
      document.getElementById('checkoutPasoRegistro').classList.remove('hidden');
      document.getElementById('checkoutNombre').value = "";
      document.getElementById('checkoutApellido').value = "";
      if (itiCheckout) itiCheckout.setNumber("");
    }

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Continuar ➡️";
    console.error("Error verificación checkout:", err);
    mostrarAviso("Error de conexión al verificar identidad.");
  }
}

async function ejecutarRegistroCheckout() {
  const nom = document.getElementById('checkoutNombre').value.trim().toUpperCase();
  const ape = document.getElementById('checkoutApellido').value.trim().toUpperCase();
  
  if (!nom || !ape) return mostrarAviso("Llene todos los campos.");
  
  let tel = "";
  if (itiCheckout) {
    if (!validarTelefonoVenezuela(itiCheckout)) {
      return mostrarAviso("Número celular no válido. Ingrese un formato correcto de Venezuela.");
    }
    tel = itiCheckout.getNumber();
  } else {
    tel = document.getElementById('checkoutTelefono').value.trim();
    if (!tel) return mostrarAviso("Llene todos los campos.");
  }
  
  const btn = document.getElementById('btnRegistrarCheckout');
  btn.disabled = true;
  btn.textContent = "Procesando...";
  
  try {
    const sb = getSupabase();
    if (!sb) throw new Error("Servicio de base de datos no disponible.");

    const { error } = await sb
      .from('clientes')
      .upsert({
        "CEDULA": cacheUsuario.cedula,
        "NOMBRES": nom,
        "APELLIDOS": ape,
        "TELEFONO": tel,
        "DIRECCION": null
      });

    btn.disabled = false;
    btn.textContent = "Registrarse y Comprar 🚀";

    if (error) {
      console.error("Error al registrar cliente checkout:", error);
      return mostrarAviso("No se pudo registrar el cliente en la base de datos.");
    }

    cacheUsuario.nombre = nom;
    cacheUsuario.apellido = ape;
    cacheUsuario.telefono = tel;
    cacheUsuario.rol = "CLIENTE";
    
    mostrarAviso("Registro completado con éxito 🎉");
    
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAutenticacionCheckout')).hide();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).show();

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Registrarse y Comprar 🚀";
    console.error(err);
    mostrarAviso("Error de conexión durante el registro.");
  }
}

function alternarTipoEntrega(tipo) { document.getElementById('contenedorUbicacion').classList.toggle('hidden', tipo === 'Pickup'); }

function procesarEnvioSolicitud() {
  datosCheckout.ubicacion = document.getElementById('tipoEntregaSelect').value === 'Pickup' ? 'Retiro Local' : document.getElementById('ubicacionEntrega').value;
  datosCheckout.formaPago = document.getElementById('formaPagoSelect').value;
  if (document.getElementById('tipoEntregaSelect').value === 'Delivery' && !datosCheckout.ubicacion) return mostrarAviso("Escriba la dirección");
  if (!datosCheckout.formaPago) return mostrarAviso("Seleccione pago");
  
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).hide();
  
  let total = 0;
  let listaHtml = '<ul class="list-unstyled mb-1">';
  for (let p in carrito) {
    listaHtml += `<li class="small mb-1">▫️ <strong>${p}</strong> (${carrito[p].cantidad}) — <span class="text-danger fw-bold">$${carrito[p].precio}</span></li>`;
    total += parseFloat(carrito[p].precio);
  }
  listaHtml += '</ul>';

  document.getElementById('cuerpoMensajeConfirmacion').innerHTML = `
    <p class="fw-bold mb-2">Por favor, verifique los detalles de su pedido:</p>
    <div class="border p-2 bg-light rounded mb-3" style="max-height: 150px; overflow-y: auto;">
      ${listaHtml}
      <div class="text-end fw-bold text-danger mt-1 fs-6">Total Estimado: $${total.toFixed(2)}</div>
    </div>
    <div class="mb-3 small">
      <strong>📍 Destino:</strong> ${datosCheckout.ubicacion}<br>
      <strong>💳 Método de Pago:</strong> ${datosCheckout.formaPago}
    </div>
    <hr class="my-2 border-secondary opacity-25">
    <div class="mb-2">
      <label class="form-label fw-bold text-success mb-1">📱 Confirme su número de WhatsApp para contacto:</label>
      <input type="tel" id="confirmarTelefono" class="form-control">
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

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalConfirmacionFinal')).show();
}

function regresarAFormulario() { 
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalConfirmacionFinal')).hide(); 
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).show(); 
}

async function ejecutarAccionFinal() {
  let telConfirmado = "";
  
  if (window.itiConfirm) {
    if (!validarTelefonoVenezuela(window.itiConfirm)) {
      return mostrarAviso("Por favor, introduzca un número de teléfono de confirmación válido.");
    }
    telConfirmado = window.itiConfirm.getNumber(); 
  } else {
    telConfirmado = document.getElementById('confirmarTelefono').value.trim();
    if (!telConfirmado) return mostrarAviso("El número de teléfono es obligatorio.");
  }

  const numeroOriginal = cacheUsuario.telefono;
  const sb = getSupabase();

  if (sb && cacheUsuario.cedula) {
    let updateFields = {};
    if (telConfirmado !== numeroOriginal) {
      cacheUsuario.telefono = telConfirmado;
      updateFields["TELEFONO"] = telConfirmado;
    }
    if (datosCheckout.ubicacion && datosCheckout.ubicacion !== 'Retiro Local') {
      updateFields["DIRECCION"] = datosCheckout.ubicacion;
    }
    if (Object.keys(updateFields).length > 0) {
      sb.from('clientes')
        .update(updateFields)
        .eq('CEDULA', cacheUsuario.cedula)
        .then(() => {})
        .catch(err => console.error("Error al actualizar cliente:", err));
    }
  }

  const btn = document.getElementById('btnAceptarFinal'); 
  btn.disabled = true; 
  btn.textContent = "Abriendo WhatsApp...";
  
  let arr = [], total = 0, listaWA = "";
  for (let p in carrito) {
    arr.push(`${p} (${carrito[p].cantidad})`);
    listaWA += `  ▫️ ${p} - ${carrito[p].cantidad}\n`;
    total += parseFloat(carrito[p].precio);
  }

  let mensajeWA = `📱 *Teléfono:* ${cacheUsuario.telefono}\n👤 *Cliente:* ${cacheUsuario.nombre} ${cacheUsuario.apellido}\n📍 *Ubicación:* ${datosCheckout.ubicacion}\n\n🛒 *Pedido Solicitado:*\n${listaWA}\n💵 *Monto Aproximado:* $${total.toFixed(2)}\n💳 *Forma de Pago:* ${datosCheckout.formaPago}\n\n⚠️ *Nota Importante:* Entiendo y acepto que el monto total reflejado es una estimación. El pago final podría variar dependiendo del peso exacto de los productos al momento de prepararlos y de la tarifa aplicable al servicio de delivery. ✅`;
  
  window.open(`https://wa.me/584121753275?text=${encodeURIComponent(mensajeWA)}`, '_blank');
  
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalConfirmacionFinal')).hide();
  document.getElementById('vistaPedido').classList.add('hidden'); 
  document.getElementById('vistaCombos').classList.remove('hidden');
  carrito = {}; 
  actualizarContadorCarrito();
  
  btn.disabled = false;
  btn.textContent = "Aceptar ✓";

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalExito')).show();
}

function abrirPanelAdmin() {
  document.getElementById('adminCatNombre').value = "";
  document.getElementById('adminCatProdNombre').value = "";
  document.getElementById('adminCatProdPrecio').value = "";
  document.getElementById('adminCatProdCodigo').value = "";
  document.getElementById('adminCatProdArchivoImagen').value = "";
  document.getElementById('adminAddProdNombre').value = "";
  document.getElementById('adminAddProdPrecio').value = "";
  document.getElementById('adminAddProdCodigo').value = "";
  document.getElementById('adminAddProdArchivoImagen').value = "";
  
  let addSelect = document.getElementById('adminAddCatSelect');
  let delSelect = document.getElementById('adminDelCatSelect');
  
  let optionsHtml = cacheCategorias.map(cat => `<option value="${cat.nombre}">${cat.nombre}</option>`).join('');
  addSelect.innerHTML = optionsHtml;
  delSelect.innerHTML = `<option value="" disabled selected>-- Elija Categoría --</option>` + optionsHtml;
  
  document.getElementById('adminDelProdSelect').innerHTML = `<option value="" disabled selected>-- Primero elija categoría --</option>`;
  
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAdminPanel')).show();
}

function cargarProductosParaEliminar(catNombre) {
  let cat = cacheCategorias.find(c => c.nombre === catNombre);
  if (!cat) return;
  let prodSelect = document.getElementById('adminDelProdSelect');
  prodSelect.innerHTML = cat.productos.map(p => `<option value="${p[0]}">${p[0]}</option>`).join('');
}

async function ejecutarCrearCategoria() {
  const catNombre = document.getElementById('adminCatNombre').value.trim();
  const prodNombre = document.getElementById('adminCatProdNombre').value.trim();
  const prodPrecio = parseFloat(document.getElementById('adminCatProdPrecio').value.trim());
  const prodCodigo = document.getElementById('adminCatProdCodigo').value.trim();
  
  if (!catNombre || !prodNombre || isNaN(prodPrecio)) {
    return mostrarAviso("Todos los campos obligatorios deben estar llenos.");
  }
  
  const modalEl = document.getElementById('modalAdminPanel');
  const btn = modalEl.querySelector(".btn-success");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  try {
    const imgData = await validarYLeerArchivoWebP(document.getElementById('adminCatProdArchivoImagen'));
    if (!imgData) throw new Error("Debe seleccionar una imagen obligatoria para el producto inicial.");

    const relativePath = `img/${imgData.name}`;
    await subirArchivoAGitHub(relativePath, imgData.base64, `Creación de categoría con imagen: ${imgData.name}`);

    cacheCategorias.push({
      nombre: catNombre.toUpperCase(),
      productos: [
        [prodNombre, prodPrecio, relativePath, true, 1, "unidades", 0, prodCodigo]
      ]
    });

    await guardarCatalogoEnGitHub();

    btn.disabled = false;
    btn.textContent = "Crear Categoría ✓";
    mostrarAviso("Categoría creada con éxito.");
    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    
    renderizarCatalogo({ categorias: cacheCategorias });

  } catch (error) {
    btn.disabled = false;
    btn.textContent = "Crear Categoría ✓";
    alert("Error: " + error);
  }
}

async function ejecutarAnexarProducto() {
  const catNombre = document.getElementById('adminAddCatSelect').value;
  const prodNombre = document.getElementById('adminAddProdNombre').value.trim();
  const prodPrecio = parseFloat(document.getElementById('adminAddProdPrecio').value.trim());
  const prodCodigo = document.getElementById('adminAddProdCodigo').value.trim();
  
  if (!catNombre || !prodNombre || isNaN(prodPrecio)) {
    return mostrarAviso("Todos los campos obligatorios deben estar llenos.");
  }
  
  const modalEl = document.getElementById('modalAdminPanel');
  const btn = modalEl.querySelector(".btn-primary");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  try {
    const imgData = await validarYLeerArchivoWebP(document.getElementById('adminAddProdArchivoImagen'));
    if (!imgData) throw new Error("Debe seleccionar una imagen obligatoria para el producto.");

    const relativePath = `img/${imgData.name}`;
    await subirArchivoAGitHub(relativePath, imgData.base64, `Anexo de producto con imagen: ${imgData.name}`);

    let cat = cacheCategorias.find(c => c.nombre === catNombre);
    if (cat) {
      let esCombo = catNombre.toUpperCase().includes("COMBO");
      let defaultUnidad = esCombo ? "unidades" : "gramos";
      let minVal = esCombo ? 1 : 250;
      cat.productos.push([prodNombre, prodPrecio, relativePath, true, minVal, defaultUnidad, 0, prodCodigo]);
    }

    await guardarCatalogoEnGitHub();

    btn.disabled = false;
    btn.textContent = "Anexar Producto ✓";
    mostrarAviso("Producto anexado con éxito.");
    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    
    renderizarCatalogo({ categorias: cacheCategorias });

  } catch (error) {
    btn.disabled = false;
    btn.textContent = "Anexar Producto ✓";
    alert("Error: " + error);
  }
}

async function ejecutarEliminarProducto() {
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

  try {
    let cat = cacheCategorias.find(c => c.nombre === catNombre);
    if (cat) {
      cat.productos = cat.productos.filter(p => p[0] !== prodNombre);
    }

    await guardarCatalogoEnGitHub();

    btn.disabled = false;
    btn.textContent = "Eliminar Producto ✕";
    mostrarAviso("Producto eliminado con éxito.");
    bootstrap.Modal.getInstance(modalEl).hide();
    
    renderizarCatalogo({ categorias: cacheCategorias });

  } catch (error) {
    btn.disabled = false;
    btn.textContent = "Eliminar Producto ✕";
    alert("Error al eliminar: " + error);
  }
}

function mostrarImagenGrande(url, nom, prec, tipo, cantMin, unidad, pesoPromedio = 0) { 
  document.getElementById('imagenGrandePopUp').src = url; 
  document.getElementById('overlayImagenGrande').classList.add('show'); 
  
  productoZoomActivo = { nom, prec, tipo, cantMin, unidad, pesoPromedio };

  const btnSelect = document.getElementById('btnSeleccionarZoom');
  if (cacheUsuario.rol === "ADMIN") {
    btnSelect.classList.add('hidden');
  } else {
    btnSelect.classList.remove('hidden');
  }

  pushZoomState();
}

function cerrarImagenGrande(e) { 
  if (e.target.id === 'overlayImagenGrande') { 
    forzarCerrarImagenGrande(); 
  } 
}

function seleccionarDesdeZoom() {
  if (productoZoomActivo && productoZoomActivo.nom) {
    const tempProd = { ...productoZoomActivo };
    forzarCerrarImagenGrande();
    seleccionarProducto(
      tempProd.nom,
      tempProd.prec,
      tempProd.tipo,
      tempProd.cantMin,
      tempProd.unidad,
      tempProd.pesoPromedio
    );
  } else {
    forzarCerrarImagenGrande();
    mostrarAviso("Por favor, seleccione el producto directamente desde su tarjeta en el catálogo.");
  }
}

function pushZoomState() {
  if (!isZoomStatePushed) {
    history.pushState({ zoomOpen: true }, "", "#zoom");
    isZoomStatePushed = true;
  }
}

function forzarCerrarImagenGrande() {
  const overlay = document.getElementById('overlayImagenGrande');
  if (overlay && overlay.classList.contains('show')) {
    overlay.classList.remove('show');
    productoZoomActivo = null;
    if (isZoomStatePushed && window.location.hash === "#zoom") {
      isZoomStatePushed = false;
      history.back();
    }
  }
}

function cerrarImagenGrandeSilencioso() {
  const overlay = document.getElementById('overlayImagenGrande');
  if (overlay) {
    overlay.classList.remove('show');
    productoZoomActivo = null;
    isZoomStatePushed = false;
  }
}

// Inicialización de Eventos y Carga
document.addEventListener("DOMContentLoaded", function() {
  const inputTelefono = document.querySelector("#regTelefono");
  if (inputTelefono) {
    iti = window.intlTelInput(inputTelefono, {
      initialCountry: "ve", 
      separateDialCode: true,
      utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js"
    });
  }

  const inputCheckoutTel = document.querySelector("#checkoutTelefono");
  if (inputCheckoutTel) {
    itiCheckout = window.intlTelInput(inputCheckoutTel, {
      initialCountry: "ve",
      separateDialCode: true,
      utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js"
    });
  }

  const urlParams = new URLSearchParams(window.location.search);
  const esAdminUrl = urlParams.has('admin') || window.location.hash === "#admin";

  if (esAdminUrl) {
    document.getElementById('btnSesionHeader').classList.remove('hidden');
    irALoginAdministrador();
  } else {
    document.getElementById('btnSesionHeader').classList.add('hidden');
    document.getElementById('saludoUsuario').innerHTML = "¡Bienvenido a <strong>Mundocarnes</strong>! 🥩";
  }

  document.getElementById('inputKg').addEventListener('input', function() {
    this.classList.remove('is-invalid');
    document.getElementById('inputGramos').classList.remove('is-invalid');
    document.getElementById('errorModalCantidad').classList.add('hidden');
  });

  document.getElementById('inputGramos').addEventListener('input', function() {
    this.classList.remove('is-invalid');
    document.getElementById('inputKg').classList.remove('is-invalid');
    document.getElementById('errorModalCantidad').classList.add('hidden');
  });

  document.getElementById('inputCantidad').addEventListener('input', function() {
    this.classList.remove('is-invalid');
    document.getElementById('errorModalCantidad').classList.add('hidden');
  });

  window.addEventListener('popstate', function(event) {
    const overlay = document.getElementById('overlayImagenGrande');
    if (overlay && overlay.classList.contains('show')) {
      cerrarImagenGrandeSilencioso();
    }
  });

  fetch("catalog.json?t=" + new Date().getTime())
    .then(res => res.json())
    .then(renderizarCatalogo)
    .catch(err => {
      console.error(err);
      mostrarAviso("Error al obtener catalog.json desde el servidor.");
    });
});
