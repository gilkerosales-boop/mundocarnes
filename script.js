/* ==========================================================================
   Lógica del Frontend e Interacción Optimizada sin Google Sheets - Mundocarnes
   ========================================================================== */

// Configuración de tu repositorio de GitHub para guardar imágenes y el JSON
const GITHUB_CONFIG = {
  owner: "gilkerosales-boop",         // Tu usuario de GitHub
  repo: "mundocarnes",                // Tu nombre de repositorio
  branch: "main"                      // Rama de tu despliegue (usualmente main)
};

// Enlace REST de Apps Script únicamente para la validación de inicio de sesión de clientes
const API_URL_CLIENTES = "https://script.google.com/macros/s/AKfycbwioDKH4HuEZoaZfw5YvbmPI4450jipV4oNBVcZcqtCciRWCM3-s8T98pU9vS9VjSbz/exec";

// Variables globales de la sesión y el carrito (Declaradas de forma segura al inicio)
let carrito = {};
let productoTemporal = {};
let productoZoomActivo = null; // Almacena el producto visualizado actualmente en la lupa
let cacheUsuario = { cedula: "", nombre: "", apellido: "", telefono: "", rol: "" };
let datosCheckout = { ubicacion: "", formaPago: "" };
let cacheCategorias = []; 
let iti;            // Instancia de intl-tel-input para el formulario de registro tradicional
let itiCheckout;    // Instancia de intl-tel-input para el modal de Checkout
let isZoomStatePushed = false; // Bandera de control para historial en zoom de imagen

// Función de comunicación REST asíncrona exclusiva para clientes
async function callClientesAPI(action, data = {}) {
  try {
    const response = await fetch(API_URL_CLIENTES, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action, ...data })
    });
    return await response.json();
  } catch (error) {
    console.error("Error en conexión REST de clientes:", error);
    return { error: "Ocurrió un retardo de conexión. Por favor intente de nuevo." };
  }
}

// Función genérica para subir o actualizar un archivo en GitHub mediante su API REST
async function subirArchivoAGitHub(path, contentBase64, commitMessage) {
  const token = sessionStorage.getItem("github_token");
  if (!token) throw new Error("Sesión administrativa no válida o expirada.");

  const url = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${path}`;

  // 1. Intentar obtener el SHA del archivo si ya existe para poder sobrescribirlo
  let sha = null;
  try {
    const resInfo = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (resInfo.ok) {
      const info = await resInfo.json();
      sha = info.sha;
    }
  } catch (e) {
    // Archivo nuevo en el repositorio
  }

  // 2. Ejecutar la subida del contenido codificado en Base64
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

// Sincroniza el catálogo JSON en memoria directamente con el repositorio de GitHub
async function guardarCatalogoEnGitHub() {
  const contentString = JSON.stringify({ categorias: cacheCategorias }, null, 2);
  // Conversión segura de string UTF-8 a Base64 compatible
  const base64Content = btoa(unescape(encodeURIComponent(contentString)));
  await subirArchivoAGitHub("catalog.json", base64Content, "Sincronización automática de catálogo desde el Modo Editor");
}

// Valida si un archivo subido es .webp y pesa menos de 120 KB, devolviendo su base64
function validarYLeerArchivoWebP(fileElement) {
  return new Promise((resolve, reject) => {
    const file = fileElement.files[0];
    if (!file) {
      resolve(null); // No se seleccionó archivo nuevo (se conserva el actual)
      return;
    }

    // Validación formal de formato WebP
    const esWebP = file.type === "image/webp" || file.name.toLowerCase().endsWith(".webp");
    if (!esWebP) {
      reject("La imagen no cumple con el formato exigido. Debe ser .webp");
      return;
    }

    // Validación estricta de tamaño (120 KB = 122880 bytes)
    const limitePeso = 120 * 1024;
    if (file.size > limitePeso) {
      reject("La imagen no cumple con el tamaño exigido. Debe pesar menos de 120 KB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
      // Extrae la cadena de datos pura en Base64
      const base64 = e.target.result.split(",")[1];
      // Reemplaza espacios por caracteres limpios en el nombre del archivo
      const safeName = file.name.replace(/\s+/g, "_").toLowerCase();
      resolve({
        base64: base64,
        name: safeName
      });
    };
    reader.onerror = function() {
      reject("Error al leer el archivo físico.");
    };
    reader.readAsDataURL(file);
  });
}

// Validador personalizado para los prefijos de Venezuela (+58) incluyendo el nuevo 0422 de Digitel
function validarTelefonoVenezuela(itiInstance) {
  if (!itiInstance) return false;
  const countryData = itiInstance.getSelectedCountryData();
  const rawNumber = itiInstance.getNumber(); // ej: +584221234567
  
  if (countryData.dialCode === "58") {
    const digitos = rawNumber.replace(/\D/g, ""); // "584221234567"
    if (digitos.length === 12 && digitos.startsWith("584")) {
      const prefijoCelular = digitos.substring(2, 5); // "422"
      const prefijosValidos = ["412", "422", "414", "424", "416", "426"];
      if (prefijosValidos.includes(prefijoCelular)) {
        return true; // Prefijo correcto de Venezuela
      }
    }
  }
  return itiInstance.isValidNumber();
}

// Muestra el aviso dinámico usando el Toast de Bootstrap 5
function mostrarAviso(mensaje) {
  try { 
    document.getElementById('toastMensaje').textContent = mensaje; 
    bootstrap.Toast.getOrCreateInstance(document.getElementById('liveToast')).show();
  } catch(e) { 
    alert(mensaje); 
  }
}

// Reestablece los estados de interfaz a su modo cliente público
function regresarAlInicio() {
  cacheUsuario = { cedula: "", nombre: "", apellido: "", telefono: "", rol: "" }; carrito = {}; cacheCategorias = [];
  document.getElementById('cedula').value = ""; document.getElementById('passwordAdmin').value = "";
  document.getElementById('regNombre').value = ""; document.getElementById('regApellido').value = "";
  
  if (iti) iti.setNumber(""); 
  if (itiCheckout) itiCheckout.setNumber("");

  document.getElementById('vistaAdminPassword').classList.add('hidden'); 
  document.getElementById('vistaRegistro').classList.add('hidden');
  document.getElementById('vistaPedido').classList.add('hidden'); 
  document.getElementById('vistaIngreso').classList.add('hidden');
  
  // Ocultar elementos de administración del catálogo público
  document.getElementById('btnAdminPanel').classList.add('hidden');
  document.getElementById('btnVerPedido').classList.remove('hidden');
  document.getElementById('btnSesionHeader').classList.add('hidden');
  document.getElementById('saludoUsuario').innerHTML = "¡Bienvenido a <strong>Mundocarnes</strong>! 🥩";

  // Saneamiento de URL: Limpia el "?admin" de la barra de direcciones sin recargar la página
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
  document.getElementById('cedula').placeholder = "Ingrese Cédula o RIF";
}

function procesarPrimerPaso() {
  const cedulaInput = document.getElementById('cedula').value.trim();
  if (!cedulaInput) { mostrarAviso("Introduzca su Cédula o RIF."); return; }
  
  const btn = document.getElementById('btnSiguiente'); 
  btn.disabled = true; 
  btn.textContent = "Verificando...";
  
  callClientesAPI("verificarUsuario", { cedula: cedulaInput }).then(function(respuesta) {
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

// Verifica el Token de GitHub validando permisos de escritura en el repositorio
async function verificarPasswordAdministrador() {
  const token = document.getElementById('passwordAdmin').value.trim();
  if (!token) return mostrarAviso("Por favor, ingrese su Token.");
  
  const btn = document.getElementById('btnAdminIngreso'); 
  btn.disabled = true;
  btn.textContent = "Validando Token...";

  try {
    const url = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}`;
    console.log("Intentando conectar con el repositorio en:", url); 
    
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
      console.error("Respuesta fallida de GitHub API. Código de Estado:", response.status);
      
      if (response.status === 404) {
        mostrarAviso("Repositorio no encontrado. Verifique que 'owner' y 'repo' en script.js coincidan con su cuenta de GitHub.");
      } else if (response.status === 401) {
        mostrarAviso("Token inválido o incorrecto.");
      } else {
        mostrarAviso("Token inválido o repositorio inaccesible.");
      }
    }
  } catch (error) {
    console.error("Error en validación:", error);
    mostrarAviso("Error al validar credenciales.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema";
  }
}

function ejecutarRegistroNuevoCliente() {
  const nom = document.getElementById('regNombre').value.trim(), ape = document.getElementById('regApellido').value.trim();
  
  if (!nom || !ape) return mostrarAviso("Llene todos los campos.");
  
  let tel = "";
  if (iti) {
    if (!validarTelefonoVenezuela(iti)) {
      return mostrarAviso("Por favor, introduzca un número de teléfono celular válido de Venezuela (prefijos: 0412, 0422, 0414, 0424, 0416, 0426).");
    }
    tel = iti.getNumber();
  } else {
    tel = document.getElementById('regTelefono').value.trim();
    if (!tel) return mostrarAviso("Llene todos los campos.");
  }
  
  const btn = document.getElementById('btnRegistrar'); 
  btn.disabled = true; 
  btn.textContent = "Registrando...";
  
  callClientesAPI("registrarCliente", { 
    cedula: cacheUsuario.cedula, 
    nombre: nom, 
    apellido: ape, 
    telefono: tel 
  }).then(function(res) {
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
    // Se agregan todos los parámetros del catálogo para el correcto funcionamiento del botón rápido en la lupa
    return `<div class="col-6 col-md-3"><div class="card h-100 p-2 position-relative">${etiquetaDisp}<img src="${f[2]}" loading="lazy" decoding="async" class="card-img-top ${claseImg}" onclick="mostrarImagenGrande('${f[2]}', '${f[0]}', '${f[1]}', '${nombreCategoria}', ${cantMin}, '${unidad}')"><h6 class="fw-bold mt-2 text-truncate">${f[0]}</h6><p class="text-success fw-bold mb-0">${f[1]} $</p><small class="text-muted" style="font-size:0.7rem;">Mín: ${cantMin} ${unidadTxt}</small>${boton}</div></div>`;
  }).join('');
}

function abrirModalEdicion(nom, prec, cat, disp, min, unidad) {
  productoTemporal = { nombre: nom, categoria: cat };
  
  document.getElementById('editProductoNuevoNombre').value = nom; 
  document.getElementById('editProductoCategoria').textContent = cat;
  document.getElementById('editProductoPrecio').value = prec;
  document.getElementById('editProductoDisponible').value = disp ? "true" : "false";
  document.getElementById('editProductoMinimo').value = min;
  document.getElementById('editProductoUnidad').value = unidad || "unidades";
  document.getElementById('editProductoArchivoImagen').value = ""; // Limpiar selector
  
  // Calcular la posición actual y el límite máximo dentro del array
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

async function guardarEdicionAdministrador() {
  const nuevoNombre = document.getElementById('editProductoNuevoNombre').value.trim();
  const prec = parseFloat(document.getElementById('editProductoPrecio').value);
  const disp = document.getElementById('editProductoDisponible').value === "true";
  const min = parseInt(document.getElementById('editProductoMinimo').value);
  const unidad = document.getElementById('editProductoUnidad').value;
  const nuevaPosicion = parseInt(document.getElementById('editProductoPosicion').value);
  
  if (!nuevoNombre || isNaN(prec) || isNaN(min) || !unidad || isNaN(nuevaPosicion)) {
    return mostrarAviso("Llene todos los campos de forma correcta");
  }
  
  const modalEl = document.getElementById('modalEditarProducto');
  const btn = modalEl.querySelector(".btn-warning");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  try {
    // 1. Validar e intentar procesar la imagen cargada localmente
    const imgData = await validarYLeerArchivoWebP(document.getElementById('editProductoArchivoImagen'));
    let relativeImgPath = null;

    if (imgData) {
      // Subir archivo a GitHub de forma directa
      const filePath = `img/${imgData.name}`;
      await subirArchivoAGitHub(filePath, imgData.base64, `Subida de imagen de producto: ${imgData.name}`);
      relativeImgPath = filePath;
    }

    // 2. Localizar y actualizar el objeto del catálogo en memoria
    let cat = cacheCategorias.find(c => c.nombre === productoTemporal.categoria);
    if (cat) {
      const oldIndex = cat.productos.findIndex(p => p[0] === productoTemporal.nombre);
      if (oldIndex !== -1) {
        let prod = cat.productos[oldIndex];
        
        // Actualizar valores del producto
        prod[0] = nuevoNombre;
        prod[1] = prec;
        prod[3] = disp;
        prod[4] = min;
        prod[5] = unidad;
        if (relativeImgPath) {
          prod[2] = relativeImgPath;
        }
        
        // Procesar la nueva posición (Ordenación del array)
        let targetIndex = nuevaPosicion - 1;
        if (targetIndex < 0) targetIndex = 0;
        if (targetIndex >= cat.productos.length) targetIndex = cat.productos.length - 1;
        
        if (oldIndex !== targetIndex) {
          // Mover quirúrgicamente el producto dentro del array
          cat.productos.splice(oldIndex, 1); // Remover del índice viejo
          cat.productos.splice(targetIndex, 0, prod); // Insertar en el índice nuevo
        }
      } else {
        throw new Error("No se localizó el producto original.");
      }
    } else {
      throw new Error("Categoría no encontrada.");
    }

    // 3. Sincronizar catálogo con GitHub
    await guardarCatalogoEnGitHub();

    btn.disabled = false;
    btn.textContent = "Guardar Cambios 💾";
    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    mostrarAviso("Producto guardado y sincronizado correctamente");
    
    // OPTIMIZACIÓN: Renderiza el catálogo al instante usando los datos en memoria
    renderizarCatalogo({ categorias: cacheCategorias });

  } catch (error) {
    btn.disabled = false;
    btn.textContent = "Guardar Cambios 💾";
    alert("Error de guardado: " + error);
  }
}

// Configura la visualización del Modal de Cantidad / Peso según la unidad del producto
function seleccionarProducto(nom, prec, tipo, cantMin, unidad) {
  productoTemporal = { nombre: nom, precio: prec, tipo: tipo, minBase: cantMin, unidad: unidad };
  document.getElementById('nombreProductoModal').textContent = nom;
  
  const contUnidades = document.getElementById('contenedorUnidades');
  const contPeso = document.getElementById('contenedorPeso');
  const errorDiv = document.getElementById('errorModalCantidad');
  
  // Limpiar errores visuales previos
  document.getElementById('inputCantidad').classList.remove('is-invalid');
  document.getElementById('inputKg').classList.remove('is-invalid');
  document.getElementById('inputGramos').classList.remove('is-invalid');
  errorDiv.classList.add('hidden');
  
  if (unidad === 'unidades') {
    contUnidades.classList.remove('hidden');
    contPeso.classList.add('hidden');
    
    let inp = document.getElementById('inputCantidad');
    inp.min = cantMin; 
    inp.value = cantMin;
  } else {
    contUnidades.classList.add('hidden');
    contPeso.classList.remove('hidden');
    
    // Dejar campos vacíos por defecto según requerimiento
    document.getElementById('inputKg').value = "";
    document.getElementById('inputGramos').value = "";
  }
  
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCantidad')).show();
}

// Procesa, valida y agrega el producto (Unidad o Peso dividido) al carrito local
function confirmarSeleccion() {
  const errorDiv = document.getElementById('errorModalCantidad');
  
  // Si el producto se cuenta por unidades
  if (productoTemporal.unidad === 'unidades') {
    const inputCant = document.getElementById('inputCantidad');
    let cant = parseInt(inputCant.value);
    
    if (isNaN(cant) || cant < productoTemporal.minBase) {
      inputCant.classList.add('is-invalid');
      errorDiv.textContent = `Por favor, indique la cantidad deseada. El mínimo es de ${productoTemporal.minBase} uds.`;
      errorDiv.classList.remove('hidden');
      return;
    }
    
    // Quitar clases de error
    inputCant.classList.remove('is-invalid');
    errorDiv.classList.add('hidden');
    
    let calc = productoTemporal.precio * cant;
    carrito[productoTemporal.nombre] = { 
      cantidad: cant + ' uds', 
      precio: calc.toFixed(2), 
      cantNumerica: cant, 
      tipo: productoTemporal.tipo, 
      unidad: productoTemporal.unidad,
      precioBase: productoTemporal.precio, 
      minBase: productoTemporal.minBase 
    };
  } 
  // Si el producto se cuenta por peso (Kg y g separados)
  else {
    const kgInput = document.getElementById('inputKg');
    const gInput = document.getElementById('inputGramos');
    
    const kgVal = parseFloat(kgInput.value) || 0;
    const gVal = parseFloat(gInput.value) || 0;
    
    const totalGramos = (kgVal * 1000) + gVal;
    
    // Validación: Ambos campos vacíos o peso acumulado menor que el mínimo de 250g
    const ambosVacios = (kgInput.value.trim() === "" && gInput.value.trim() === "");
    if (ambosVacios || totalGramos < 250) {
      kgInput.classList.add('is-invalid');
      gInput.classList.add('is-invalid');
      errorDiv.textContent = "Por favor, indique el peso deseado para su producto. El peso total debe ser de al menos 250g.";
      errorDiv.classList.remove('hidden');
      return;
    }
    
    // Remover clases de error si pasa la validación
    kgInput.classList.remove('is-invalid');
    gInput.classList.remove('is-invalid');
    errorDiv.classList.add('hidden');
    
    let calc = (productoTemporal.precio / 1000) * totalGramos;
    
    // Formatear texto de cantidad de forma estética para el carrito, ej: "1 Kg 250 g" o "350 g"
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
      minBase: productoTemporal.minBase 
    };
  }
  
  mostrarAviso(`Agregado: ${productoTemporal.nombre}`);
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCantidad')).hide();
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
  
  if (item.unidad === 'unidades') {
    item.cantidad = cant + ' uds';
    item.precio = (item.precioBase * cant).toFixed(2);
  } else {
    // Re-formatear peso dinámico en Kg / g si es inline
    let cantidadTxt = "";
    const kgEnteros = Math.floor(cant / 1000);
    const gramosRestantes = cant % 1000;
    if (kgEnteros > 0) {
      cantidadTxt += `${kgEnteros} Kg`;
      if (gramosRestantes > 0) cantidadTxt += ` ${gramosRestantes} g`;
    } else {
      text = cantidadTxt += `${gramosRestantes} g`;
    }
    item.cantidad = cantidadTxt;
    item.precio = ((item.precioBase / 1000) * cant).toFixed(2);
  }
  mostrarPedido();
}

function eliminarDelCarrito(p) { delete carrito[p]; mostrarPedido(); }
function cerrarPedido() { document.getElementById('vistaPedido').classList.add('hidden'); document.getElementById('vistaCombos').classList.remove('hidden'); }

// Redirección y lógica de autenticación diferida en Checkout
function abrirSolicitudPago() {
  if(!Object.keys(carrito).length) return;
  
  // Si el cliente ya está identificado por haber iniciado sesión o haberse registrado previamente
  if (cacheUsuario.cedula && cacheUsuario.telefono) {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).show();
  } else {
    // Abrir modal de autenticación diferido
    document.getElementById('checkoutPasoCedula').classList.remove('hidden');
    document.getElementById('checkoutPasoRegistro').classList.add('hidden');
    document.getElementById('checkoutCedula').value = "";
    
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAutenticacionCheckout')).show();
  }
}

// Evalúa si la cédula ingresada en Checkout existe para autocompletar o registrar
function verificarClienteCheckout() {
  const cedulaInput = document.getElementById('checkoutCedula').value.trim();
  if (!cedulaInput) return mostrarAviso("Por favor, ingrese su Cédula o RIF.");
  
  const btn = document.getElementById('btnContinuarCheckout');
  btn.disabled = true;
  btn.textContent = "Verificando...";
  
  callClientesAPI("verificarUsuario", { cedula: cedulaInput }).then(function(respuesta) {
    btn.disabled = false;
    btn.textContent = "Continuar ➡️";
    
    if (respuesta.error) return alert("Aviso: " + respuesta.error);
    
    cacheUsuario.cedula = cedulaInput;
    
    if (respuesta.status === "CLIENTE") {
      // Cliente recurrente localizado, autocompletamos su sesión de compra
      cacheUsuario.nombre = respuesta.nombre;
      cacheUsuario.apellido = respuesta.apellido;
      cacheUsuario.telefono = respuesta.telefono;
      cacheUsuario.rol = "CLIENTE";
      
      mostrarAviso(`Bienvenido de nuevo, ${respuesta.nombre} 👋`);
      
      // Ocultar modal de autenticación y abrir modal de entrega/pago
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAutenticacionCheckout')).hide();
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).show();
      
    } else if (respuesta.status === "ADMIN") {
      mostrarAviso("Identificado como administrador. Inicie sesión desde el menú superior.");
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAutenticacionCheckout')).hide();
      irALoginAdministrador();
    } else {
      // Cliente nuevo. Transicionar al formulario de registro del checkout
      document.getElementById('checkoutPasoCedula').classList.add('hidden');
      document.getElementById('checkoutPasoRegistro').classList.remove('hidden');
      document.getElementById('checkoutNombre').value = "";
      document.getElementById('checkoutApellido').value = "";
      if (itiCheckout) itiCheckout.setNumber("");
    }
  }).catch(function(err) {
    btn.disabled = false;
    btn.textContent = "Continuar ➡️";
    alert("Error de conexión al verificar identidad.");
  });
}

// Ejecuta el registro del cliente nuevo directamente en el checkout
function ejecutarRegistroCheckout() {
  const nom = document.getElementById('checkoutNombre').value.trim();
  const ape = document.getElementById('checkoutApellido').value.trim();
  
  if (!nom || !ape) return mostrarAviso("Llene todos los campos.");
  
  let tel = "";
  if (itiCheckout) {
    // Validación adaptada compatible con prefijo 0422 de Digitel
    if (!validarTelefonoVenezuela(itiCheckout)) {
      return mostrarAviso("Número celular no válido. Ingrese un formato correcto de Venezuela (prefijos: 0412, 0422, 0414, 0424, 0416, 0426).");
    }
    tel = itiCheckout.getNumber();
  } else {
    tel = document.getElementById('checkoutTelefono').value.trim();
    if (!tel) return mostrarAviso("Llene todos los campos.");
  }
  
  const btn = document.getElementById('btnRegistrarCheckout');
  btn.disabled = true;
  btn.textContent = "Procesando...";
  
  callClientesAPI("registrarCliente", { 
    cedula: cacheUsuario.cedula, 
    nombre: nom, 
    apellido: ape, 
    telefono: tel 
  }).then(function(res) {
    btn.disabled = false;
    btn.textContent = "Registrarse y Comprar 🚀";
    if (res.error) return alert(res.error);
    
    cacheUsuario.nombre = nom.toUpperCase();
    cacheUsuario.apellido = ape.toUpperCase();
    cacheUsuario.telefono = tel;
    cacheUsuario.rol = "CLIENTE";
    
    mostrarAviso("Registro completado con éxito 🎉");
    
    // Cerrar modal de autenticación y pasar directamente a la selección de entrega/pago
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAutenticacionCheckout')).hide();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).show();
  }).catch(function() {
    btn.disabled = false;
    btn.textContent = "Registrarse y Comprar 🚀";
  });
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

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalConfirmacionFinal')).show();
}

function regresarAFormulario() { bootstrap.Modal.getOrCreateInstance(document.getElementById('modalConfirmacionFinal')).hide(); bootstrap.Modal.getOrCreateInstance(document.getElementById('modalSolicitudPago')).show(); }

// Nueva Función de confirmación instantánea: Remueve la carga síncrona en Sheets y redirige de inmediato
function ejecutarAccionFinal() {
  let telConfirmado = "";
  
  if (window.itiConfirm) {
    // Validación compatible integrada
    if (!validarTelefonoVenezuela(window.itiConfirm)) {
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
    
    // Llamada asíncrona ("fire-and-forget"). No bloquea el flujo principal de redirección
    callClientesAPI("actualizarTelefonoCliente", { cedula: cacheUsuario.cedula, nuevoTelefono: telConfirmado })
      .catch(function(err) {
        console.error("Error al actualizar teléfono en base de datos:", err);
      });
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
  
  // Abre WhatsApp instantáneamente
  window.open(`https://wa.me/584121753275?text=${encodeURIComponent(mensajeWA)}`, '_blank');
  
  // Resetear interfaz del carrito localmente
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalConfirmacionFinal')).hide();
  document.getElementById('vistaPedido').classList.add('hidden'); 
  document.getElementById('vistaCombos').classList.remove('hidden');
  carrito = {}; 
  
  btn.disabled = false;
  btn.textContent = "Aceptar ✓";

  // Mostrar aviso de éxito local sin esperas de red
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalExito')).show();
}

function abrirPanelAdmin() {
  document.getElementById('adminCatNombre').value = "";
  document.getElementById('adminCatProdNombre').value = "";
  document.getElementById('adminCatProdPrecio').value = "";
  document.getElementById('adminCatProdArchivoImagen').value = "";
  document.getElementById('adminAddProdNombre').value = "";
  document.getElementById('adminAddProdPrecio').value = "";
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
  
  if (!catNombre || !prodNombre || isNaN(prodPrecio)) {
    return mostrarAviso("Todos los campos son obligatorios.");
  }
  
  const modalEl = document.getElementById('modalAdminPanel');
  const btn = modalEl.querySelector(".btn-success");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  try {
    const imgData = await validarYLeerArchivoWebP(document.getElementById('adminCatProdArchivoImagen'));
    if (!imgData) {
      throw new Error("Debe seleccionar una imagen obligatoria para el producto inicial.");
    }

    // 1. Subir imagen a GitHub
    const relativePath = `img/${imgData.name}`;
    await subirArchivoAGitHub(relativePath, imgData.base64, `Creación de categoría con imagen: ${imgData.name}`);

    // 2. Insertar nueva categoría en memoria
    cacheCategorias.push({
      nombre: catNombre.toUpperCase(),
      productos: [
        [prodNombre, prodPrecio, relativePath, true, 1, "unidades"]
      ]
    });

    // 3. Sincronizar catálogo
    await guardarCatalogoEnGitHub();

    btn.disabled = false;
    btn.textContent = "Crear Categoría ✓";
    mostrarAviso("Categoría creada con éxito.");
    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    
    // OPTIMIZACIÓN: Renderiza el catálogo al instante usando los datos en memoria
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
  
  if (!catNombre || !prodNombre || isNaN(prodPrecio)) {
    return mostrarAviso("Todos los campos son obligatorios.");
  }
  
  const modalEl = document.getElementById('modalAdminPanel');
  const btn = modalEl.querySelector(".btn-primary");
  btn.disabled = true;
  btn.textContent = "Procesando...";

  try {
    const imgData = await validarYLeerArchivoWebP(document.getElementById('adminAddProdArchivoImagen'));
    if (!imgData) {
      throw new Error("Debe seleccionar una imagen obligatoria para el producto.");
    }

    // 1. Subir imagen a GitHub
    const relativePath = `img/${imgData.name}`;
    await subirArchivoAGitHub(relativePath, imgData.base64, `Anexo de producto con imagen: ${imgData.name}`);

    // 2. Insertar en la categoría correspondiente en memoria
    let cat = cacheCategorias.find(c => c.nombre === catNombre);
    if (cat) {
      // Por defecto asume unidades para combos y gramos para el resto
      let esCombo = catNombre.toUpperCase().includes("COMBO");
      let defaultUnidad = esCombo ? "unidades" : "gramos";
      let minVal = esCombo ? 1 : 1000;
      cat.productos.push([prodNombre, prodPrecio, relativePath, true, minVal, defaultUnidad]);
    }

    // 3. Sincronizar catálogo
    await guardarCatalogoEnGitHub();

    btn.disabled = false;
    btn.textContent = "Anexar Producto ✓";
    mostrarAviso("Producto anexado con éxito.");
    bootstrap.Modal.getOrCreateInstance(modalEl).hide();
    
    // OPTIMIZACIÓN: Renderiza el catálogo al instante usando los datos en memoria
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
      // Filtrar y eliminar el producto del array
      cat.productos = cat.productos.filter(p => p[0] !== prodNombre);
    }

    // Sincronizar catálogo actualizado
    await guardarCatalogoEnGitHub();

    btn.disabled = false;
    btn.textContent = "Eliminar Producto ✕";
    mostrarAviso("Producto eliminado con éxito.");
    bootstrap.Modal.getInstance(modalEl).hide();
    
    // OPTIMIZACIÓN: Renderiza el catálogo al instante usando los datos en memoria
    renderizarCatalogo({ categorias: cacheCategorias });

  } catch (error) {
    btn.disabled = false;
    btn.textContent = "Eliminar Producto ✕";
    alert("Error al eliminar: " + error);
  }
}

// Abre la imagen ampliada y guarda las referencias dinámicas del producto
function mostrarImagenGrande(url, nom, prec, tipo, cantMin, unidad) { 
  document.getElementById('imagenGrandePopUp').src = url; 
  document.getElementById('overlayImagenGrande').classList.add('show'); 
  
  // Guardar la referencia exacta del producto para selección rápida desde la lupa
  productoZoomActivo = { nom, prec, tipo, cantMin, unidad };

  // Ocultar botón de selección rápida si el usuario actual es administrador (Modo Editor)
  const btnSelect = document.getElementById('btnSeleccionarZoom');
  if (cacheUsuario.rol === "ADMIN") {
    btnSelect.classList.add('hidden');
  } else {
    btnSelect.classList.remove('hidden');
  }

  // Push del estado virtual al historial para capturar botón "Atrás" en móviles
  pushZoomState();
}

// Cierra el zoom manualmente evaluando clics en el fondo
function cerrarImagenGrande(e) { 
  if (e.target.id === 'overlayImagenGrande') { 
    forzarCerrarImagenGrande(); 
  } 
}

// Cierra la lupa y ejecuta la redirección directa al modal de selección de peso/unidades
function seleccionarDesdeZoom() {
  if (productoZoomActivo && productoZoomActivo.nom) { // <--- PROTECCIÓN AGREGADA
    forzarCerrarImagenGrande();
    seleccionarProducto(
      productoZoomActivo.nom,
      productoZoomActivo.prec,
      productoZoomActivo.tipo,
      productoZoomActivo.cantMin,
      productoZoomActivo.unidad
    );
  } else {
    // Saneamiento por si la caché del navegador conserva tarjetas antiguas sin metadatos
    forzarCerrarImagenGrande();
    mostrarAviso("Por favor, seleccione el producto directamente desde su tarjeta en el catálogo.");
  }
}

// Registra el estado virtual en la pila del navegador para móviles
function pushZoomState() {
  if (!isZoomStatePushed) {
    history.pushState({ zoomOpen: true }, "", "#zoom");
    isZoomStatePushed = true;
  }
}

// Cierre forzado manual (limpia estado de historial retrocediendo)
function forzarCerrarImagenGrande() {
  const overlay = document.getElementById('overlayImagenGrande');
  if (overlay && overlay.classList.contains('show')) {
    overlay.classList.remove('show');
    productoZoomActivo = null;
    if (isZoomStatePushed && window.location.hash === "#zoom") {
      isZoomStatePushed = false;
      history.back(); // Pop del estado virtual
    }
  }
}

// Cierre silencioso desencadenado por el botón físico "Atrás" (evita bucles)
function cerrarImagenGrandeSilencioso() {
  const overlay = document.getElementById('overlayImagenGrande');
  if (overlay) {
    overlay.classList.remove('show');
    productoZoomActivo = null;
    isZoomStatePushed = false;
  }
}

// Inicialización de intl-tel-input en la carga del DOM y listeners dinámicos
document.addEventListener("DOMContentLoaded", function() {
  const inputTelefono = document.querySelector("#regTelefono");
  if (inputTelefono) {
    iti = window.intlTelInput(inputTelefono, {
      initialCountry: "ve", 
      separateDialCode: true,
      utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js"
    });
  }

  // Inicialización de intl-tel-input para el Checkout
  const inputCheckoutTel = document.querySelector("#checkoutTelefono");
  if (inputCheckoutTel) {
    itiCheckout = window.intlTelInput(inputCheckoutTel, {
      initialCountry: "ve",
      separateDialCode: true,
      utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js"
    });
  }

  // DETECTAR PARÁMETRO OCULTO DE ADMINISTRADOR (?admin o #admin)
  const urlParams = new URLSearchParams(window.location.search);
  const esAdminUrl = urlParams.has('admin') || window.location.hash === "#admin";

  if (esAdminUrl) {
    document.getElementById('btnSesionHeader').classList.remove('hidden');
    irALoginAdministrador();
  } else {
    document.getElementById('btnSesionHeader').classList.add('hidden');
    document.getElementById('saludoUsuario').innerHTML = "¡Bienvenido a <strong>Mundocarnes</strong>! 🥩";
  }

  // Listeners para limpiar bordes rojos de error en tiempo real (Excelente UX)
  document.getElementById('inputKg').addEventListener('input', function() {
    this.classList.remove('is-invalid');
    document.getElementById('inputGramos').classList.remove('is-invalid');
    document.getElementById('errorModalCantidad').classList.add('hidden');
  }); // <--- OJO: AQUÍ HABÍA UN ERROR DE SINTAXIS (Cierre de addEventListener incorrecto)

  document.getElementById('inputGramos').addEventListener('input', function() {
    this.classList.remove('is-invalid');
    document.getElementById('inputKg').classList.remove('is-invalid');
    document.getElementById('errorModalCantidad').classList.add('hidden');
  });

  document.getElementById('inputCantidad').addEventListener('input', function() {
    this.classList.remove('is-invalid');
    document.getElementById('errorModalCantidad').classList.add('hidden');
  });

  // Escucha global de eventos de historial para el botón "Atrás" en móviles
  window.addEventListener('popstate', function(event) {
    const overlay = document.getElementById('overlayImagenGrande');
    if (overlay && overlay.classList.contains('show')) {
      cerrarImagenGrandeSilencioso();
    }
  });

  // Cargar Catálogo de forma local directa de GitHub Pages en milisegundos
  fetch("catalog.json?t=" + new Date().getTime())
    .then(res => res.json())
    .then(renderizarCatalogo)
    .catch(err => {
      console.error(err);
      mostrarAviso("Error al obtener catalog.json desde el servidor.");
    });
});
