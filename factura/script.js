/* ==========================================================================
   Lógica del Módulo de Ventas / Facturación No Fiscal y Fiscal - Mundocarnes
   Integración Universal The Factory HKA (HKA80 / Aclas PP9 Plus),
   Emisión Dual, Reportes X / Z, Cuentas por Cobrar (Créditos y Vales) y Sync
   ========================================================================== */

// Configuración de Supabase
const SUPABASE_URL = "https://bdhlgiygrozdebhmwyds.supabase.co";
const SUPABASE_KEY = "sb_publishable_qA5isaOYl_QZzB_WiZsIPA_zjWnTO_6";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// GitHub API Config para sincronizar catalog.json desde Facturación
const GITHUB_CONFIG_FAC = {
  owner: "gilkerosales-boop",
  repo: "mundocarnes",
  branch: "main"
};

// Pre-carga del logotipo oficial para comprobantes impresos
const logoComprobantePreload = new Image();
logoComprobantePreload.src = "../img/LOGO-MUNDO123.webp";

// Clasificación de Métodos por Naturaleza de Moneda
const METODOS_USD = ["Efectivo Divisas", "Zelle", "PayPal", "Cashea", "Crédito"];
const METODOS_BS = ["Pago Móvil", "Efectivo Bolívares", "Punto de Venta", "Transferencia Bancaria", "Biopago"];

let itemsFactura = {};
let transaccionActiva = null;
let facturasEnEspera = [];
let productoTemporalFactura = {};
let cacheCategoriasFactura = [];
let clienteFacturaActual = null;
let monedaVistaModal = "USD";
let datosFacturaPendiente = null;
let itemsEscaneadosTemporales = [];
let cacheHistorialFacturas = [];
let datosCierreCajaPendiente = null;
let listaFlatProductosCodigos = [];
let listaMovimientosEfectivo = [];
let cacheHistorialCierres = [];
let cacheHistorialCreditos = [];
let cacheHistorialVales = [];
let subTabCXCActual = "creditos";
let modoFiscalActivo = false;
let sincronizandoEnProceso = false;
let accionPendienteGitHub = null;

// Normalizar nombres de usuario para coincidir con las tablas en Supabase
function normalizarUsuario(u) {
  let user = (u || sessionStorage.getItem("factura_usuario") || "admin").toLowerCase().trim();
  if (user === "maika" || user === "mayka") return "mayka";
  return user;
}

// Obtener el usuario activo normalizado actual
function obtenerUsuarioActivo() {
  return normalizarUsuario(sessionStorage.getItem("factura_usuario"));
}

// Determinar el nombre de la tabla de VENTAS personal según el usuario activo
function obtenerTablaVentasUsuario(u) {
  return `ventas_${normalizarUsuario(u)}`;
}

// Determinar el nombre de la tabla de CIERRES personal según el usuario activo
function obtenerTablaCierresUsuario(u) {
  return `cierres_${normalizarUsuario(u)}`;
}

// Obtener datos fiscales y comerciales dinámicos de la empresa
function obtenerDatosEmpresa() {
  const guardado = localStorage.getItem("pos_empresa_config");
  if (guardado) {
    try {
      const d = JSON.parse(guardado);
      return {
        nombre: (d.nombre || "FRIGORIFICO MUNDOCARNES, C.A.").toUpperCase(),
        rif: (d.rif || "J-505072889").toUpperCase(),
        direccion1: (d.direccion1 || "AV. SAN MARTIN CC ATLANTICO NIVEL PB").toUpperCase(),
        direccion2: (d.direccion2 || "LOCAL 1 URB ARTIGAS CARACAS").toUpperCase(),
        direccion3: (d.direccion3 || "DISTRITO CAPITAL").toUpperCase(),
        telefono: d.telefono || "0412-1753275"
      };
    } catch (e) {}
  }
 return {
    nombre: "FRIGORIFICO MUNDOCARNES, C.A.",
    rif: "J-505072889",
    direccion1: "AV. SAN MARTIN CC ATLANTICO NIVEL PB",
    direccion2: "LOCAL 1 URB ARTIGAS CARACAS",
    direccion3: "DISTRITO CAPITAL",
    telefono: "0412-1753275"
  };
}
window.obtenerDatosEmpresa = obtenerDatosEmpresa;

// Obtener el número de registro / serial fiscal privado configurado o detectado por hardware
function obtenerSerialFiscalActivo() {
  const modelo = (window.fiscalDriver ? window.fiscalDriver.modelo : localStorage.getItem("pos_modelo_impresora_fiscal")) || "HKA80";
  const serialPorModelo = localStorage.getItem(`pos_serial_fiscal_${modelo}`);
  if (serialPorModelo && serialPorModelo.trim()) {
    return serialPorModelo.trim().toUpperCase();
  }
  const serialActivo = localStorage.getItem("pos_serial_fiscal_activo");
  if (serialActivo && serialActivo.trim()) {
    return serialActivo.trim().toUpperCase();
  }
  return ""; // Sin seriales fijos quemados en código fuente
}
window.obtenerSerialFiscalActivo = obtenerSerialFiscalActivo;

// ==========================================================================
// MOTOR DE BASE DE DATOS LOCAL INDEXEDDB (OFFLINE-FIRST A 0ms)
// ==========================================================================
function abrirDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MundocarnesPOS_DB", 4);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("clientes")) {
        db.createObjectStore("clientes", { keyPath: "cedula" });
      }
      if (!db.objectStoreNames.contains("ventas")) {
        db.createObjectStore("ventas", { keyPath: "numFactura" });
      }
      if (!db.objectStoreNames.contains("creditos")) {
        db.createObjectStore("creditos", { keyPath: "numFactura" });
      }
      if (!db.objectStoreNames.contains("vales")) {
        db.createObjectStore("vales", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("movimientos")) {
        db.createObjectStore("movimientos", { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("cierres")) {
        db.createObjectStore("cierres", { autoIncrement: true, keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("syncQueue")) {
        db.createObjectStore("syncQueue", { autoIncrement: true, keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("config")) {
        db.createObjectStore("config", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(storeName, key) {
  try {
    const db = await abrirDB();
    if (!db || !db.objectStoreNames.contains(storeName)) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (errTx) {
        resolve(null);
      }
    });
  } catch (e) {
    return null;
  }
}

async function dbPut(storeName, item) {
  try {
    const db = await abrirDB();
    if (!db || !db.objectStoreNames.contains(storeName)) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        
        // Si el objeto no tiene ID válido en un almacén autoincremental, retirar propiedad vacía
        if (storeName === "cierres" && (item.id === undefined || item.id === null)) {
          delete item.id;
        }

        const req = store.put(item);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => {
          console.warn(`Aviso dbPut en ${storeName}:`, e);
          resolve(null);
        };
      } catch (errTx) {
        console.warn(`Excepción dbPut en ${storeName}:`, errTx);
        resolve(null);
      }
    });
  } catch (e) {
    console.warn("Error dbPut:", e);
    return null;
  }
}

async function dbGetAll(storeName) {
  try {
    const db = await abrirDB();
    if (!db || !db.objectStoreNames.contains(storeName)) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (errTx) {
        resolve([]);
      }
    });
  } catch (e) {
    return [];
  }
}

async function dbDelete(storeName, key) {
  try {
    const db = await abrirDB();
    if (!db || !db.objectStoreNames.contains(storeName)) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      } catch (errTx) {
        resolve(false);
      }
    });
  } catch (e) {
    return false;
  }
}

// ==========================================================================
// CLIENTE REST API DE GITHUB PARA POS
// ==========================================================================
async function subirArchivoAGitHubFactura(path, contentBase64, commitMessage) {
  const token = sessionStorage.getItem("github_token");
  if (!token) throw new Error("Sesión o token de autorización de GitHub no disponible.");

  const url = `https://api.github.com/repos/${GITHUB_CONFIG_FAC.owner}/${GITHUB_CONFIG_FAC.repo}/contents/${path}`;

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
    branch: GITHUB_CONFIG_FAC.branch
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
    throw new Error(errData.message || "Fallo en la comunicación con GitHub API.");
  }
  return await response.json();
}

// ==========================================================================
// GESTIÓN DEL MODO FISCAL DUAL Y MODELOS (HKA80 / ACLAS PP9 PLUS)
// ==========================================================================
let timerMonitorHardwareFiscal = null;
let ultimoEstadoSensorFiscal = "LISTA";

function iniciarMonitorSensoresFiscal() {
  if (timerMonitorHardwareFiscal) clearInterval(timerMonitorHardwareFiscal);
  
  timerMonitorHardwareFiscal = setInterval(async () => {
    // Solo sondear si no hay una impresión en curso para no colisionar el canal
    if (modoFiscalActivo && window.fiscalDriver && window.fiscalDriver.conectado && !window.fiscalDriver.ocupadoTransmision) {
      const stHw = await window.fiscalDriver.verificarEstadoHardware();
      
      if (!stHw.ok && (stHw.codigo === "TAPA_ABIERTA" || stHw.codigo === "SIN_PAPEL" || stHw.codigo === "ERROR_CONEXION")) {
        actualizarBotonHardwareFiscal(stHw.codigo, stHw.mensaje);
        // Mostrar alerta solo en el momento del cambio de estado (sin repetición)
        if (ultimoEstadoSensorFiscal !== stHw.codigo) {
          ultimoEstadoSensorFiscal = stHw.codigo;
          mostrarAvisoFactura(stHw.mensaje, true, 4000);
        }
      } else if (stHw.ok) {
        // Si se cerró la tapa o se colocó papel, avisar una sola vez y mantener botón verde silencioso
        if (ultimoEstadoSensorFiscal !== "LISTA") {
          ultimoEstadoSensorFiscal = "LISTA";
          mostrarAvisoFactura(`🟢 ${window.fiscalDriver.getNombreModelo()} lista.`, true, 2500);
        }
        actualizarBotonHardwareFiscal("LISTA");
      }
    }
  }, 3500);
}

function inicializarModoFiscal() {
  const guardado = localStorage.getItem("pos_modo_fiscal");
  modoFiscalActivo = (guardado === "true");

  const chk = document.getElementById('chkModoFiscal');
  if (chk) chk.checked = modoFiscalActivo;

  const modeloGuardado = localStorage.getItem("pos_modelo_impresora_fiscal") || "PP9";

  if (window.fiscalDriver) {
    window.fiscalDriver.setModelo(modeloGuardado);

    window.fiscalDriver.onStatusChange(({ estado, mensaje }) => {
      actualizarBotonHardwareFiscal(estado);
      if (estado === "CONECTADO") {
        mostrarAvisoFactura(`🟢 Impresora Fiscal ${window.fiscalDriver.getNombreModelo()} Conectada.`);
      } else if (estado === "ERROR_CONEXION" || estado === "DESCONECTADO") {
        mostrarAvisoFactura("⚠️ " + mensaje);
      }
    });

    if (modoFiscalActivo) {
      window.fiscalDriver.reconectarAutomatico();
    }
  }

  actualizarInterfazModoFiscal();
}

function alternarModoFiscalPOS(estaActivo) {
  modoFiscalActivo = estaActivo;
  localStorage.setItem("pos_modo_fiscal", estaActivo ? "true" : "false");
  actualizarInterfazModoFiscal();

  if (estaActivo) {
    const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "Fiscal";
    mostrarAvisoFactura(`🟢 Modo Fiscal ACTIVADO (${nombreModelo})`);
    if (window.fiscalDriver && !window.fiscalDriver.conectado) {
      window.fiscalDriver.reconectarAutomatico().then(conectado => {
        if (!conectado) {
          mostrarAvisoFactura(`ℹ️ Conecte la ${nombreModelo} haciendo clic en '🔌 Conectar Fiscal'.`);
        }
      });
    }
  } else {
    mostrarAvisoFactura("📄 Modo Control Interno ACTIVADO (Ticketera XP-80C)");
  }
}

async function cambiarModeloImpresoraFiscal(nuevoModelo) {
  if (window.fiscalDriver) {
    window.fiscalDriver.ultimoReporteStatus = null; // Limpiar serial residual anterior
    window.fiscalDriver.setModelo(nuevoModelo);
    actualizarInterfazModoFiscal();
    
    const nombreModelo = window.fiscalDriver.getNombreModelo();
    const serialActivo = obtenerSerialFiscalActivo();
    mostrarAvisoFactura(`🖨️ ${nombreModelo} activa con N° Registro: ${serialActivo}`);

    if (modoFiscalActivo) {
      const reconectado = await window.fiscalDriver.reconectarAutomatico();
      actualizarBotonHardwareFiscal(reconectado ? "CONECTADO" : "DESCONECTADO");
    }
  }
}

function actualizarInterfazModoFiscal() {
  const badgeModo = document.getElementById('badgeModoFiscal');
  const btnConectar = document.getElementById('btnConectarFiscal');
  const btnHero = document.getElementById('btnEjecutarFacturarHero');
  const btnModalEmitir = document.getElementById('btnEmitirFacturaFinal');
  const labelTituloCobro = document.getElementById('labelProcesarFactura');
  const btnRepX = document.getElementById('btnReporteXFiscal');

  const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "Fiscal";
  const modeloTag = window.fiscalDriver ? window.fiscalDriver.modelo : "PP9";

  if (modoFiscalActivo) {
    if (badgeModo) {
      badgeModo.textContent = `🟢 Fiscal`;
      badgeModo.className = "badge-modo-fiscal fiscal-on";
    }
    if (btnConectar) btnConectar.classList.remove('hidden');
    if (btnRepX) btnRepX.classList.remove('hidden');
    if (btnHero) {
      btnHero.textContent = `Factura Fiscal (${modeloTag}) 🧾`;
      btnHero.className = "btn btn-facturar-hero btn-facturar-fiscal w-100 mb-2 shadow";
    }
    if (btnModalEmitir) {
      btnModalEmitir.textContent = `🧾 Emitir Factura Fiscal (${modeloTag})`;
      btnModalEmitir.className = "btn btn-primary fw-bold px-5 py-2 fs-5 rounded-pill shadow";
    }
    if (labelTituloCobro) {
      labelTituloCobro.textContent = `🧾 Procesar Factura Fiscal (${nombreModelo})`;
    }
  } else {
    if (badgeModo) {
      badgeModo.textContent = "📄 No Fiscal";
      badgeModo.className = "badge-modo-fiscal fiscal-off";
    }
    if (btnConectar) btnConectar.classList.add('hidden');
    if (btnRepX) btnRepX.classList.add('hidden');
    if (btnHero) {
      btnHero.textContent = "Facturar 🧾";
      btnHero.className = "btn btn-facturar-hero w-100 mb-2 shadow";
    }
    if (btnModalEmitir) {
      btnModalEmitir.textContent = "🧾 Emitir Recibo No Fiscal";
      btnModalEmitir.className = "btn btn-success fw-bold px-5 py-2 fs-5 rounded-pill shadow";
    }
    if (labelTituloCobro) {
      labelTituloCobro.textContent = "🧾 Procesar Recibo de Pago (Control Interno)";
    }
  }

  const boxIVAPanel = document.getElementById('contenedorDesgloseIVA');
  const boxIVAModal = document.getElementById('contenedorDesgloseIVAModal');
  const contCheckEspecial = document.getElementById('contCheckContribuyenteEspecial');
  const contToggleIGTF = document.getElementById('contToggleIGTF3');
  const panelRetencion = document.getElementById('panelConfiguracionRetencionIVA');
  const contInfoFiscal = document.getElementById('contenedorLiquidacionFiscalInfo');

  if (boxIVAPanel) {
    if (modoFiscalActivo) boxIVAPanel.classList.remove('hidden');
    else boxIVAPanel.classList.add('hidden');
  }
  if (boxIVAModal) {
    if (modoFiscalActivo) boxIVAModal.classList.remove('hidden');
    else boxIVAModal.classList.add('hidden');
  }

  if (contCheckEspecial) {
    if (modoFiscalActivo) contCheckEspecial.classList.remove('hidden');
    else {
      contCheckEspecial.classList.add('hidden');
      if (panelRetencion) panelRetencion.classList.add('hidden');
      const chkEsp = document.getElementById('chkEsContribuyenteEspecial');
      if (chkEsp) chkEsp.checked = false;
    }
  }
  if (contToggleIGTF) {
    if (modoFiscalActivo) contToggleIGTF.classList.remove('hidden');
    else {
      contToggleIGTF.classList.add('hidden');
      const chkIGTF = document.getElementById('chkPercibirIGTF3');
      if (chkIGTF) chkIGTF.checked = false;
    }
  }
  if (contInfoFiscal && !modoFiscalActivo) {
    contInfoFiscal.classList.add('hidden');
  }

  if (typeof recalcularTotalesRetencionEIGTF === "function") {
    recalcularTotalesRetencionEIGTF();
  }

  if (window.fiscalDriver) {
    actualizarBotonHardwareFiscal(window.fiscalDriver.conectado ? "CONECTADO" : "DESCONECTADO");
  }
}

async function conectarImpresoraFiscalManual() {
  if (!window.fiscalDriver) {
    return mostrarAvisoFactura("Driver fiscal no disponible en el sistema.");
  }

  try {
    const btn = document.getElementById('btnConectarFiscal');
    if (btn) { btn.disabled = true; btn.textContent = "Conectando..."; }
    
    await window.fiscalDriver.solicitarYConectar();
    
    if (btn) { btn.disabled = false; }
    actualizarBotonHardwareFiscal("CONECTADO");
  } catch (err) {
    const btn = document.getElementById('btnConectarFiscal');
    if (btn) { btn.disabled = false; }
    actualizarBotonHardwareFiscal("DESCONECTADO");
    mostrarAvisoFactura("Error al conectar: " + err.message);
  }
}

function actualizarBotonHardwareFiscal(estado) {
  const btn = document.getElementById('btnConectarFiscal');
  if (!btn) return;

  const modeloTag = window.fiscalDriver ? window.fiscalDriver.modelo : "Fiscal";
  const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "Impresora Fiscal";

  // Mantener verde si la impresora está conectada o acaba de finalizar una impresión exitosa
  const estaRealmenteConectado = (window.fiscalDriver && window.fiscalDriver.conectado) || 
    estado === "CONECTADO" || estado === "LISTA" || String(estado).startsWith("FINALIZADO");

  if (estaRealmenteConectado && estado !== "ERROR_CONEXION" && estado !== "DESCONECTADO") {
    btn.className = "btn btn-sm btn-success fw-bold btn-hardware-fiscal";
    btn.innerHTML = `🟢 ${modeloTag} Lista`;
    btn.title = `Impresora fiscal ${nombreModelo} conectada y lista para facturar.`;
  } else {
    btn.className = "btn btn-sm btn-outline-info text-white fw-bold btn-hardware-fiscal";
    btn.innerHTML = `🔌 Conectar ${modeloTag}`;
    btn.title = `Haga clic para seleccionar y abrir el puerto USB/Serial de la ${nombreModelo}.`;
  }
}

async function ejecutarReporteXFiscalDirecto() {
  if (!window.fiscalDriver || !window.fiscalDriver.conectado) {
    const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "Impresora Fiscal";
    return mostrarAvisoFactura(`Conecte la ${nombreModelo} antes de solicitar el Reporte X.`);
  }

  const nombreModelo = window.fiscalDriver.getNombreModelo();
  if (!confirm(`¿Desea emitir el Reporte X (Corte Parcial) en la ${nombreModelo}?`)) return;

  try {
    mostrarAvisoFactura(`Emitiendo Reporte X en ${nombreModelo}...`);
    await window.fiscalDriver.imprimirReporteX();
    mostrarAvisoFactura("✅ Reporte X emitido exitosamente.");
  } catch (e) {
    mostrarAvisoFactura("Error al emitir Reporte X: " + e.message);
  }
}

// ==========================================================================
// CÁLCULO TRIBUTARIO CONDICIONADO ESTRICTAMENTE AL MODO FISCAL
// ==========================================================================
function calcularTotalesTributarios(itemsObj, forzarModoFiscal = null) {
  const esFiscal = (forzarModoFiscal !== null) ? forzarModoFiscal : modoFiscalActivo;
  let montoExento = 0;
  let montoBase16 = 0;
  let montoIVA16 = 0;
  let montoBase8 = 0;
  let montoIVA8 = 0;
  let totalGeneral = 0;

  for (let key in itemsObj) {
    const item = itemsObj[key];
    const precioTotal = parseFloat(item.precioTotal) || 0;
    const tasa = (item.tasaIVA || "E").toUpperCase();
    totalGeneral += precioTotal;

    // SI NO ES MODO FISCAL: CERO IVA (Todo se trata como importe directo sin impuestos)
    if (!esFiscal) {
      montoExento += precioTotal;
    } else {
      if (tasa === "G" || tasa === "16") {
        const base = precioTotal / 1.16;
        const iva = precioTotal - base;
        montoBase16 += base;
        montoIVA16 += iva;
      } else if (tasa === "R" || tasa === "8") {
        const base = precioTotal / 1.08;
        const iva = precioTotal - base;
        montoBase8 += base;
        montoIVA8 += iva;
      } else {
        montoExento += precioTotal;
      }
    }
  }

  const totalIVA = esFiscal ? (montoIVA16 + montoIVA8) : 0;
  const totalBaseGravable = esFiscal ? (montoBase16 + montoBase8) : 0;

  return {
    montoExento: parseFloat(montoExento.toFixed(2)),
    montoBase: parseFloat(totalBaseGravable.toFixed(2)),
    montoIVA: parseFloat(totalIVA.toFixed(2)),
    totalGeneral: parseFloat(totalGeneral.toFixed(2))
  };
}

// ==========================================================================
// CONSULTA PAGINADA DE VENTAS SUPABASE
// ==========================================================================
async function obtenerTodasLasVentasSupabase(tablaPersonalizada) {
  const tabla = tablaPersonalizada || obtenerTablaVentasUsuario();
  let todas = [];
  let from = 0;
  const step = 1000;
  let continuar = true;

  while (continuar) {
    try {
      const { data, error } = await supabaseClient
        .from(tabla)
        .select('*')
        .range(from, from + step - 1);

      if (error || !data || data.length === 0) {
        continuar = false;
      } else {
        todas = todas.concat(data);
        if (data.length < step) {
          continuar = false;
        } else {
          from += step;
        }
      }
    } catch (e) {
      continuar = false;
    }
  }

  return todas;
}

// ==========================================================================
// ELIMINACIÓN DE FACTURA EN SUPABASE
// ==========================================================================
async function ejecutarEliminarVentaSupabase(numFactura, tablaPersonalizada) {
  const tabla = tablaPersonalizada || obtenerTablaVentasUsuario();
  try {
    const { error } = await supabaseClient
      .from(tabla)
      .delete()
      .eq('FACTURA', numFactura);

    if (!error) return true;
  } catch (e) {
    console.warn(`Aviso eliminación en ${tabla}:`, e);
  }

  return true;
}

// ==========================================================================
// MOTOR DE SINCRONIZACIÓN Y DOBLE REGISTRO
// ==========================================================================
async function actualizarEstadoSyncBadge() {
  const badge = document.getElementById('badgeEstadoSync');
  if (!badge) return;

  const queue = await dbGetAll("syncQueue");
  const count = queue.length;

  if (!navigator.onLine) {
    badge.className = "badge bg-danger fw-bold me-1";
    badge.textContent = `🔴 Offline (${count} pend.)`;
  } else if (count > 0) {
    badge.className = "badge bg-warning text-dark fw-bold me-1";
    badge.textContent = `🟠 Sincronizando (${count})...`;
  } else {
    badge.className = "badge bg-success fw-bold me-1";
    badge.textContent = `🟢 Sincronizado`;
  }
}

async function procesarColaSincronizacion() {
  if (sincronizandoEnProceso || !navigator.onLine) {
    actualizarEstadoSyncBadge();
    return;
  }

  const queue = await dbGetAll("syncQueue");
  if (queue.length === 0) {
    actualizarEstadoSyncBadge();
    return;
  }

  sincronizandoEnProceso = true;
  actualizarEstadoSyncBadge();

  for (let item of queue) {
    try {
      const payload = item.payload;

      if (payload.action === "guardarFacturaFinal") {
        const d = payload.datosFactura;
        const desgl = d.desglosePagos || {};
        const tablaPersonal = d.tablaVentas || obtenerTablaVentasUsuario(d.usuario);

        const registroVenta = {
          "FACTURA": d.numFactura,
          "FECHA": d.fechaStr || new Date().toLocaleString('es-VE'),
          "CEDULA O RIF": d.cedula,
          "NOMBRE / RAZON SOCIAL": d.nombre,
          "UBICACION": d.direccion || null,
          "PRODUCTOS": d.productosSummary,
          "FORMA DE PAGO": d.formaPago,
          "MONTO TOTAL": parseFloat(d.montoTotal) || 0,
          "EFECTIVO DIVISAS": parseFloat(desgl["Efectivo Divisas"]) || 0,
          "EFECTIVO BOLIVARES": parseFloat(desgl["Efectivo Bolívares"]) || 0,
          "PAGO MOVIL": parseFloat(desgl["Pago Móvil"]) || 0,
          "ZELLE": parseFloat(desgl["Zelle"]) || 0,
          "PAYPAL": parseFloat(desgl["PayPal"]) || 0,
          "CASHEA": parseFloat(desgl["Cashea"]) || 0,
          "CREDITO": parseFloat(desgl["Crédito"]) || 0,
          "PUNTO DE VENTA": parseFloat(desgl["Punto de Venta"]) || 0,
          "TRANSFERENCIA": parseFloat(desgl["Transferencia Bancaria"]) || 0,
          "BIOPAGO": parseFloat(desgl["Biopago"]) || 0,
          // Columnas Fiscales SENIAT y Trazabilidad de Nota de Crédito
          "ES_FISCAL": Boolean(d.esFiscal),
          "ES_NOTA_CREDITO": Boolean(d.esNotaCredito || String(d.numFactura || "").startsWith("NC-") || String(d.formaPago || "").includes("NOTA DE CREDITO")),
          "FACTURA_AFECTADA": d.facturaAfectada || null,
          "COMPROBANTE_RETENCION": d.comprobanteRetencion || null,
          "MONTO_RETENCION_BS": parseFloat(d.montoRetencionBS) || 0,
          "MONTO_RETENCION_USD": parseFloat(d.montoRetencionUSD) || 0,
          "MONTO_IGTF_BS": parseFloat(d.montoIGTF_BS) || 0,
          "MONTO_IGTF_USD": parseFloat(d.montoIGTF_USD) || 0,
          "TOTAL_NETO_COBRADO_BS": parseFloat(d.totalNetoCobradoBS) || 0,
          "TOTAL_NETO_COBRADO_USD": parseFloat(d.totalNetoCobradoUSD) || 0
        };

        const { error: errGlobal } = await supabaseClient.from('ventas').insert([registroVenta]);
        if (errGlobal && errGlobal.code !== '23505') throw errGlobal;

        if (tablaPersonal && tablaPersonal !== 'ventas') {
          const { error: errPers } = await supabaseClient.from(tablaPersonal).insert([registroVenta]);
          if (errPers && errPers.code !== '23505') throw errPers;
        }

        const montoCredito = parseFloat(desgl["Crédito"]) || (d.formaPago && d.formaPago.toUpperCase().includes("CRÉDITO") ? parseFloat(d.montoTotal) : 0);
        if (montoCredito > 0) {
          const registroCreditoSupabase = {
            "FACTURA": d.numFactura,
            "FECHA": d.fechaStr || new Date().toLocaleString('es-VE'),
            "CEDULA O RIF": d.cedula,
            "NOMBRE / RAZON SOCIAL": d.nombre,
            "TELEFONO": (d.cliente && d.cliente.telefono) ? d.cliente.telefono : (d.telefono || 'N/D'),
            "UBICACION": d.direccion || null,
            "PRODUCTOS": d.productosSummary,
            "MONTO CREDITO": montoCredito,
            "ESTATUS": "EN ESPERA DE PAGO",
            "USUARIO": d.usuario ? d.usuario.toUpperCase() : "CAJERO",
            "FECHA PAGO": null
          };

          try {
            const { error: errCred } = await supabaseClient.from('creditos').insert([registroCreditoSupabase]);
            if (errCred && errCred.code !== '23505') {
              console.warn("Aviso inserción Supabase creditos:", errCred);
            }
          } catch (eCred) {}

          const registroCreditoLocal = {
            numFactura: d.numFactura,
            ...registroCreditoSupabase
          };
          await dbPut("creditos", registroCreditoLocal);
        }

      } else if (payload.action === "registrarClienteFactura") {
        const { error: errCli } = await supabaseClient.from('clientes').upsert({
          "CEDULA": payload.cedula,
          "NOMBRES": payload.nombre,
          "TELEFONO": payload.telefono,
          "DIRECCION": payload.direccion || null
        });
        if (errCli) throw errCli;

      } else if (payload.action === "guardarCierreCaja") {
        const d = payload.datosCierre;
        const r = d.resumen || {};
        const tablaCierresPersonal = d.tablaCierres || obtenerTablaCierresUsuario(d.usuario);

        const registroCierre = {
          "FECHA": d.fechaStr || new Date().toLocaleString('es-VE'),
          "USUARIO": d.usuario,
          "INICIAL $": parseFloat(d.inicialUSD) || 0,
          "INICIAL Bs": parseFloat(d.inicialBS) || 0,
          "DIVISAS": parseFloat(r.ventasEfectivoUSD) || 0,
          "BOLIVARES": parseFloat(r.ventasEfectivoBS) || 0,
          "PAGO MOVIL": parseFloat(r.ventasPagoMovil) || 0,
          "ZELLE": parseFloat(r.ventasZelle) || 0,
          "PAYPAL": parseFloat(r.ventasPayPal) || 0,
          "PUNTO DE VENTA": parseFloat(r.ventasPuntoVenta) || 0,
          "BIOPAGO": parseFloat(r.ventasBiopago) || 0,
          "CASHEA": parseFloat(r.ventasCashea) || 0,
          "CREDITO": parseFloat(r.ventasCredito) || 0,
          "TRANSFERENCIA": parseFloat(r.ventasTransferencia) || 0,
          "TOTAL 1": parseFloat(r.totalGeneralVentasUSD) || 0,
          "TOTAL 2": parseFloat(r.totalGeneralVentasBS) || 0,
          "TOTAL 3": parseFloat(d.totalCajaUSD) || 0,
          "TOTAL 4": parseFloat(d.totalCajaBS) || 0,
          "ES_FISCAL": Boolean(d.modoFiscal || d.esFiscal),
          "NUMERO_Z": d.numeroZ || null
        };

        const { error: errCieGlobal } = await supabaseClient.from('cierres').insert([registroCierre]);
        if (errCieGlobal && errCieGlobal.code !== '23505') throw errCieGlobal;

        if (tablaCierresPersonal && tablaCierresPersonal !== 'cierres') {
          const { error: errCiePers } = await supabaseClient.from(tablaCierresPersonal).insert([registroCierre]);
          if (errCiePers && errCiePers.code !== '23505') throw errCiePers;
        }

      } else if (payload.action === "eliminarFactura") {
        await ejecutarEliminarVentaSupabase(payload.numFactura, 'ventas');
        if (payload.tablaVentas && payload.tablaVentas !== 'ventas') {
          await ejecutarEliminarVentaSupabase(payload.numFactura, payload.tablaVentas);
        }
        try {
          await supabaseClient.from('creditos').delete().eq('FACTURA', payload.numFactura);
        } catch (eDelCred) {}
        await dbDelete("creditos", payload.numFactura);

      } else if (payload.action === "eliminarCierreCaja") {
        const tablaCierresPersonal = payload.tablaCierres || obtenerTablaCierresUsuario(payload.usuario);
        const fStr = payload.fechaStr;

        if (fStr) {
          await supabaseClient.from('cierres').delete().eq('FECHA', fStr);
          if (tablaCierresPersonal && tablaCierresPersonal !== 'cierres') {
            await supabaseClient.from(tablaCierresPersonal).delete().eq('FECHA', fStr);
          }
        } else if (payload.id) {
          await supabaseClient.from('cierres').delete().eq('id', payload.id);
          if (tablaCierresPersonal && tablaCierresPersonal !== 'cierres') {
            await supabaseClient.from(tablaCierresPersonal).delete().eq('id', payload.id);
          }
        }

      } else if (payload.action === "actualizarEstatusCredito") {
        await supabaseClient.from('creditos')
          .update({
            "ESTATUS": payload.estatus,
            "FECHA PAGO": payload.fechaPago
          })
          .eq('FACTURA', payload.numFactura);

      } else if (payload.action === "eliminarCredito") {
        await supabaseClient.from('creditos').delete().eq('FACTURA', payload.numFactura);

      } else if (payload.action === "guardarVale") {
        const v = payload.datosVale;
        const registroValeSupabase = {
          "FECHA": v.fechaHora || new Date().toLocaleString('es-VE'),
          "EMPLEADO": v.empleadoNombre,
          "CEDULA": v.empleadoCedula,
          "MONTO": parseFloat(v.monto) || 0,
          "MONEDA": v.moneda || 'USD',
          "MOTIVO": v.motivo,
          "CUOTAS": String(v.cuotas || '1'),
          "AUTORIZADO POR": v.autorizadoPor,
          "USUARIO": v.usuario || obtenerUsuarioActivo().toUpperCase(),
          "ESTATUS": v.estatus || "PENDIENTE",
          "FECHA PAGO": v.fechaPago || null
        };
        const { data: resVale, error: errVale } = await supabaseClient.from('vales').insert([registroValeSupabase]).select();
        if (!errVale && resVale && resVale[0] && payload.localId) {
          await dbPut("vales", {
            ...registroValeSupabase,
            id: resVale[0].id
          });
        }

      } else if (payload.action === "actualizarEstatusVale") {
        if (payload.id) {
          await supabaseClient.from('vales')
            .update({
              "ESTATUS": payload.estatus,
              "FECHA PAGO": payload.fechaPago
            })
            .eq('id', payload.id);
        } else if (payload.fechaHora && payload.cedula) {
          await supabaseClient.from('vales')
            .update({
              "ESTATUS": payload.estatus,
              "FECHA PAGO": payload.fechaPago
            })
            .eq('FECHA', payload.fechaHora)
            .eq('CEDULA', payload.cedula);
        }

      } else if (payload.action === "eliminarVale") {
        if (payload.id) {
          await supabaseClient.from('vales').delete().eq('id', payload.id);
        } else if (payload.fechaHora && payload.cedula) {
          await supabaseClient.from('vales').delete().eq('FECHA', payload.fechaHora).eq('CEDULA', payload.cedula);
        }
      }

      await dbDelete("syncQueue", item.id);

    } catch (err) {
      console.warn("Aviso Sync Supabase:", err);
      if (err && (
        err.code === '23505' || 
        err.code === '42501' || 
        err.name === 'DataError' || 
        String(err.message || '').includes('duplicate key') || 
        String(err.message || '').includes('row-level security') ||
        String(err.message || '').includes('key path')
      )) {
        await dbDelete("syncQueue", item.id);
        continue;
      }
      break;
    }
  }

  sincronizandoEnProceso = false;
  actualizarEstadoSyncBadge();
}

async function forzarSincronizacionManual() {
  if (!navigator.onLine) {
    mostrarAvisoFactura("Dispositivo Offline. Conéctese a Internet para sincronizar.");
    return;
  }

  const badge = document.getElementById('badgeEstadoSync');
  if (badge) {
    badge.className = "badge bg-warning text-dark fw-bold me-1";
    badge.textContent = "🔄 Sincronizando...";
  }

  mostrarAvisoFactura("🔄 Paso 1/5: Subiendo pendientes...", false);
  await procesarColaSincronizacion();
  await new Promise(r => setTimeout(r, 300));

  mostrarAvisoFactura("🔄 Paso 2/5: Sincronizando Clientes...", false);
  let cantClientes = 0;
  try {
    const { data: clientesSup, error } = await supabaseClient.from('clientes').select('*');
    if (!error && clientesSup) {
      cantClientes = clientesSup.length;
      for (let c of clientesSup) {
        await dbPut("clientes", {
          cedula: c.CEDULA,
          nombre: c.NOMBRES || 'N/D',
          telefono: c.TELEFONO || 'N/D',
          direccion: c.DIRECCION || null
        });
      }
    }
  } catch (e) {}

  const usuarioActivo = obtenerUsuarioActivo();
  const tablaUsuarioActivo = obtenerTablaVentasUsuario(usuarioActivo);
  mostrarAvisoFactura(`🔄 Paso 3/5: Sincronizando Ventas (${tablaUsuarioActivo})...`, false);
  let cantVentas = 0;
  try {
    const ventasSup = await obtenerTodasLasVentasSupabase(tablaUsuarioActivo);
    if (ventasSup && ventasSup.length > 0) {
      cantVentas = ventasSup.length;
      const ventasOrdenadas = [...ventasSup].sort((a, b) => {
        let numA = parseInt(String(a["FACTURA"] || a["FACTURA N°"] || "").replace(/\D/g, ''), 10) || 0;
        let numB = parseInt(String(b["FACTURA"] || b["FACTURA N°"] || "").replace(/\D/g, ''), 10) || 0;
        return numB - numA;
      });

      const maxAGuardar = Math.min(ventasOrdenadas.length, 500);
      for (let i = 0; i < maxAGuardar; i++) {
        let v = ventasOrdenadas[i];
        await dbPut("ventas", {
          numFactura: v["FACTURA"] || v["FACTURA N°"],
          fechaStr: v["FECHA"] || "",
          cedula: v["CEDULA O RIF"] || "",
          nombre: v["NOMBRE / RAZON SOCIAL"] || "",
          direccion: v["UBICACION"] || null,
          productosSummary: v["PRODUCTOS"] || "",
          formaPagoStr: v["FORMA DE PAGO"] || "",
          montoTotalUSD: parseFloat(v["MONTO TOTAL"]) || 0,
          usuario: usuarioActivo,
          esFiscal: v["FORMA DE PAGO"] ? v["FORMA DE PAGO"].includes("FISCAL") : false
        });
      }
    }
  } catch (e) {}

  const tablaCierresUsuario = obtenerTablaCierresUsuario(usuarioActivo);
  mostrarAvisoFactura(`🔄 Paso 4/5: Sincronizando Cierres (${tablaCierresUsuario})...`, false);
  let cantCierres = 0;
  try {
    const { data: cierresSup, error } = await supabaseClient.from(tablaCierresUsuario).select('*');
    if (!error && cierresSup) {
      cantCierres = cierresSup.length;
      const cierresOrdenados = [...cierresSup].sort((a, b) => (b.id || 0) - (a.id || 0));

      for (let cie of cierresOrdenados) {
        await dbPut("cierres", {
          id: cie.id,
          fechaStr: cie["FECHA"] || "",
          usuario: usuarioActivo,
          inicialUSD: parseFloat(cie["INICIAL $"]) || 0,
          inicialBS: parseFloat(cie["INICIAL Bs"]) || 0,
          cajaFinalUSD: parseFloat(cie["TOTAL 3"]) || 0,
          cajaFinalBS: parseFloat(cie["TOTAL 4"]) || 0,
          totalVentasUSD: parseFloat(cie["TOTAL 1"]) || 0,
          totalVentasBS: parseFloat(cie["TOTAL 2"]) || 0,
          esFiscal: Boolean(cie["ES_FISCAL"] || cie.esFiscal || cie.modoFiscal || cie["NUMERO_Z"] || cie["NUMERO Z"] || cie.numeroZ),
          modoFiscal: Boolean(cie["ES_FISCAL"] || cie.esFiscal || cie.modoFiscal || cie["NUMERO_Z"] || cie["NUMERO Z"] || cie.numeroZ),
          numeroZ: cie["NUMERO_Z"] || cie["NUMERO Z"] || cie.numeroZ || null,
          resumen: {
            ventasEfectivoUSD: parseFloat(cie["DIVISAS"]) || 0,
            ventasEfectivoBS: parseFloat(cie["BOLIVARES"]) || 0,
            ventasPagoMovil: parseFloat(cie["PAGO MOVIL"]) || 0,
            ventasZelle: parseFloat(cie["ZELLE"]) || 0,
            ventasPayPal: parseFloat(cie["PAYPAL"]) || 0,
            ventasPuntoVenta: parseFloat(cie["PUNTO DE VENTA"]) || 0,
            ventasBiopago: parseFloat(cie["BIOPAGO"]) || 0,
            ventasCashea: parseFloat(cie["CASHEA"]) || 0,
            ventasCredito: parseFloat(cie["CREDITO"]) || 0,
            ventasTransferencia: parseFloat(cie["TRANSFERENCIA"] || cie["TRANSFERECIA"]) || 0,
            totalGeneralVentasUSD: parseFloat(cie["TOTAL 1"]) || 0,
            totalGeneralVentasBS: parseFloat(cie["TOTAL 2"]) || 0
          }
        });
      }
    }
  } catch (e) {}

  mostrarAvisoFactura(`🔄 Paso 5/5: Sincronizando Créditos y Vales...`, false);
  let cantCreditos = 0;
  let cantVales = 0;
  try {
    const { data: credSup } = await supabaseClient.from('creditos').select('*');
    if (credSup) {
      cantCreditos = credSup.length;
      for (let cr of credSup) {
        await dbPut("creditos", {
          numFactura: cr.FACTURA,
          FACTURA: cr.FACTURA,
          FECHA: cr.FECHA,
          "CEDULA O RIF": cr["CEDULA O RIF"],
          "NOMBRE / RAZON SOCIAL": cr["NOMBRE / RAZON SOCIAL"],
          TELEFONO: cr.TELEFONO || 'N/D',
          UBICACION: cr.UBICACION || null,
          PRODUCTOS: cr.PRODUCTOS || "",
          "MONTO CREDITO": parseFloat(cr["MONTO CREDITO"]) || 0,
          ESTATUS: cr.ESTATUS || "EN ESPERA DE PAGO",
          USUARIO: cr.USUARIO || "CAJERO",
          "FECHA PAGO": cr["FECHA PAGO"] || null
        });
      }
    }

    const { data: valesSup } = await supabaseClient.from('vales').select('*');
    if (valesSup) {
      cantVales = valesSup.length;
      for (let v of valesSup) {
        await dbPut("vales", {
          id: v.id,
          FECHA: v.FECHA,
          EMPLEADO: v.EMPLEADO,
          CEDULA: v.CEDULA,
          MONTO: parseFloat(v.MONTO) || 0,
          MONEDA: v.MONEDA || 'USD',
          MOTIVO: v.MOTIVO,
          CUOTAS: String(v.CUOTAS || '1'),
          "AUTORIZADO POR": v["AUTORIZADO POR"],
          USUARIO: v.USUARIO || "CAJERO",
          ESTATUS: v.ESTATUS || "PENDIENTE",
          "FECHA PAGO": v["FECHA PAGO"] || null
        });
      }
    }
  } catch (eCXC) {}

  await actualizarEstadoSyncBadge();
  mostrarAvisoFactura(`🎉 ¡Sincronizado! (${cantClientes} cli, ${cantVentas} vtas, ${cantCierres} cierres, ${cantCreditos} créd, ${cantVales} vales)`, true, 8000);
}

async function sincronizarClientesDesdeServidor() {
  if (!navigator.onLine) return;
  try {
    const { data, error } = await supabaseClient.from('clientes').select('*');
    if (!error && data) {
      for (let cli of data) {
        await dbPut("clientes", {
          cedula: cli.CEDULA,
          nombre: cli.NOMBRES || 'N/D',
          telefono: cli.TELEFONO || 'N/D',
          direccion: cli.DIRECCION || null
        });
      }
    }
  } catch (e) {}
}

// CORRELATIVO GLOBAL ROBUSTO Y BLINDADO CONTRA SALTOS ATÍPICOS
async function obtenerSiguienteCorrelativoLocal() {
  let ultimoNum = 0;

  const ventasLocales = await dbGetAll("ventas");
  ventasLocales.forEach(v => {
    if (v.numFactura && !String(v.numFactura).includes("375")) {
      let match = String(v.numFactura).match(/\d+$/);
      if (match) {
        let n = parseInt(match[0], 10);
        // Filtrar saltos anómalos superiores a 100.000
        if (n > ultimoNum && n < 100000) ultimoNum = n;
      }
    }
  });

  const queue = await dbGetAll("syncQueue");
  queue.forEach(item => {
    if (item.payload && item.payload.datosFactura && item.payload.datosFactura.numFactura) {
      let facStr = String(item.payload.datosFactura.numFactura);
      if (!facStr.includes("375")) {
        let match = facStr.match(/\d+$/);
        if (match) {
          let n = parseInt(match[0], 10);
          if (n > ultimoNum && n < 100000) ultimoNum = n;
        }
      }
    }
  });

  const cfgCorrelativo = await dbGet("config", "ultimoCorrelativo");
  if (cfgCorrelativo && typeof cfgCorrelativo.value === "number" && cfgCorrelativo.value > ultimoNum && cfgCorrelativo.value < 100000) {
    ultimoNum = cfgCorrelativo.value;
  }

  if (navigator.onLine) {
    try {
      let from = 0;
      const step = 1000;
      let continuar = true;

      while (continuar) {
        const { data: facs, error } = await supabaseClient
          .from('ventas')
          .select('FACTURA')
          .range(from, from + step - 1);

        if (error || !facs || facs.length === 0) {
          continuar = false;
        } else {
          facs.forEach(v => {
            let facStr = v.FACTURA || v["FACTURA N°"];
            if (facStr && !String(facStr).includes("375")) {
              let match = String(facStr).match(/\d+$/);
              if (match) {
                let n = parseInt(match[0], 10);
                if (n > ultimoNum && n < 100000) ultimoNum = n;
              }
            }
          });

          if (facs.length < step) {
            continuar = false;
          } else {
            from += step;
          }
        }
      }
    } catch (e) {
      console.warn("Aviso correlativo en ventas:", e);
    }
  }

  let siguienteNum = ultimoNum + 1;
  await dbPut("config", { key: "ultimoCorrelativo", value: siguienteNum });

  let numPadded = String(siguienteNum).padStart(5, '0');
  return "001-" + numPadded;
}

// IMPRESIÓN TÉRMICA XP-80C
function ejecutarImpresionTicket(ticketHtml) {
  const elemImpresion = document.getElementById('contenidoTicketImprimible');
  if (!elemImpresion) return;

  elemImpresion.innerHTML = ticketHtml;

  const img = elemImpresion.querySelector('img.ticket-logo-centrado');
  if (img && !img.complete) {
    img.onload = function () { window.print(); };
    img.onerror = function () { window.print(); };
  } else {
    window.print();
  }
}

// MANEJADOR DE CAPAS Z-INDEX
document.addEventListener('show.bs.modal', function (event) {
  const modal = event.target;
  const openModals = document.querySelectorAll('.modal.show');
  const openCount = openModals.length;
  
  if (openCount > 0) {
    const baseZIndex = 1050 + (openCount * 20);
    modal.style.zIndex = baseZIndex + 10;
    
    setTimeout(() => {
      const backdrops = document.querySelectorAll('.modal-backdrop');
      if (backdrops.length > 1) {
        backdrops[backdrops.length - 1].style.zIndex = baseZIndex;
      }
    }, 10);
  }
});

document.addEventListener('hidden.bs.modal', function () {
  const openModals = document.querySelectorAll('.modal.show');
  if (openModals.length > 0) {
    document.body.classList.add('modal-open');
  }
});

function mostrarAvisoFactura(mensaje, autohide = true, delay = 5000) {
  try {
    const elemMsg = document.getElementById('toastMensajeFactura');
    if (elemMsg) elemMsg.textContent = mensaje;
    const toastElem = document.getElementById('toastFactura');
    if (toastElem) {
      let toastObj = bootstrap.Toast.getInstance(toastElem);
      if (!toastObj) {
        toastObj = new bootstrap.Toast(toastElem, { autohide: autohide, delay: delay });
      } else {
        toastObj._config.autohide = autohide;
        toastObj._config.delay = delay;
      }
      toastObj.show();
    }
  } catch (e) {}
}

function obtenerTasaBCV() {
  const inputTasa = document.getElementById('facTasaBCV');
  let val = inputTasa ? parseFloat(inputTasa.value) : 0;
  
  if (!val || isNaN(val) || val <= 0) {
    const usuario = sessionStorage.getItem("factura_usuario") || "global";
    const tasaGuardada = localStorage.getItem("tasa_bcv_user_" + usuario);
    val = parseFloat(tasaGuardada) || 0;
  }
  return val;
}

function alternarMonedaTablaFactura() {
  monedaVistaModal = (monedaVistaModal === "USD") ? "BS" : "USD";
  
  const btn = document.getElementById('btnConmutarMoneda');
  if (btn) {
    if (monedaVistaModal === "BS") {
      btn.textContent = "💵 Ver en Divisas ($)";
      btn.className = "btn btn-sm btn-dark fw-bold rounded-pill";
    } else {
      btn.textContent = "💱 Ver en Bolívares (Bs)";
      btn.className = "btn btn-sm btn-outline-dark fw-bold rounded-pill";
    }
  }

  renderizarTablaModalFactura();
  calcularTotalPagoMixto();
}

function renderizarTablaModalFactura() {
  const tasa = obtenerTasaBCV();
  let htmlTabla = "";
  const items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

  for (let key in items) {
    let item = items[key];
    let precioTotalUSD = parseFloat(item.precioTotal) || 0;
    let precioBaseUSD = parseFloat(item.precioBase) || 0;
    let tasaIVA = (item.tasaIVA || "E").toUpperCase();

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

    let colCantidadHtml = item.cantidadTxt;
    if (item.unidad === 'mixto') {
      let pesoGramosActual = item.pesoTotalGramos || 0;
      colCantidadHtml = `
        <div class="d-flex align-items-center justify-content-center gap-1">
          <span class="small fw-bold">${item.cantNumerica} uds (</span>
          <input type="number" class="form-control form-control-sm text-center fw-bold p-1 text-danger num-legible" style="width: 80px;" value="${pesoGramosActual}" min="1" step="10" oninput="ajustarPesoMixtoFactura('${key}', this.value)" title="Modificar peso real en gramos">
          <span class="small fw-bold">g)</span>
        </div>`;
    }

   let badgeIVA = "-";
    if (modoFiscalActivo) {
      badgeIVA = (tasaIVA === "G" || tasaIVA === "16")
        ? `<span class="badge bg-danger">G (16%)</span>`
        : (tasaIVA === "R" || tasaIVA === "8" ? `<span class="badge bg-info text-dark">R (8%)</span>` : `<span class="badge bg-secondary">E (0%)</span>`);
    } else {
      badgeIVA = `<span class="badge bg-light text-muted border">No Fiscal</span>`;
    }
    let safeIdKey = key.replace(/[^a-zA-Z0-9]/g, '_');

    htmlTabla += `
      <tr>
        <td class="text-center">
          <img src="${imgRuta}" class="img-thumb-factura" alt="${key}">
        </td>
        <td class="fw-bold">${key}</td>
        <td class="text-center">${badgeIVA}</td>
        <td class="text-center num-legible">${precioBaseTxt}</td>
        <td class="text-center fw-bold num-legible">${colCantidadHtml}</td>
        <td class="text-end fw-bold text-success num-legible" id="subtotal-modal-${safeIdKey}">${subtotalTxt}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 border-0 fw-bold" onclick="eliminarItemFacturaEnProceso('${key}')" title="Eliminar">✕</button>
        </td>
      </tr>`;
  }

  const tbody = document.getElementById('tablaModalResumenProductos');
  if (tbody) {
    tbody.innerHTML = htmlTabla || `<tr><td colspan="7" class="text-center text-muted py-3">No hay productos en esta factura.</td></tr>`;
  }

  const tributos = calcularTotalesTributarios(items);
  const elemExento = document.getElementById('modalMontoExento');
  const elemBase = document.getElementById('modalMontoBase');
  const elemIVA = document.getElementById('modalMontoIVA');
  const elemEtiquetaTotal = document.getElementById('labelModalTotalFactura');
  const elemMontoTotal = document.getElementById('montoModalTotalFactura');

  if (monedaVistaModal === "BS") {
    let totalBs = tributos.totalGeneral * tasa;
    let exentoBs = tributos.montoExento * tasa;
    let baseBs = tributos.montoBase * tasa;
    let ivaBs = tributos.montoIVA * tasa;

    if (elemExento) elemExento.textContent = `Bs. ${exentoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elemBase) elemBase.textContent = `Bs. ${baseBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elemIVA) elemIVA.textContent = `Bs. ${ivaBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    if (elemEtiquetaTotal) elemEtiquetaTotal.textContent = "TOTAL FACTURA (Bs):";
    if (elemMontoTotal) elemMontoTotal.textContent = `Bs. ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else {
    if (elemExento) elemExento.textContent = `$${tributos.montoExento.toFixed(2)}`;
    if (elemBase) elemBase.textContent = `$${tributos.montoBase.toFixed(2)}`;
    if (elemIVA) elemIVA.textContent = `$${tributos.montoIVA.toFixed(2)}`;

    if (elemEtiquetaTotal) elemEtiquetaTotal.textContent = "TOTAL FACTURA ($):";
    if (elemMontoTotal) elemMontoTotal.textContent = `$${tributos.totalGeneral.toFixed(2)}`;
  }
}

function eliminarItemFacturaEnProceso(nombreProducto) {
  if (transaccionActiva && transaccionActiva.items) {
    delete transaccionActiva.items[nombreProducto];
    renderizarTablaModalFactura();
    actualizarCalculosBCV();
  }
}

function ajustarPesoMixtoFactura(nombreProducto, nuevoPesoGramos) {
  let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;
  let item = items[nombreProducto];
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

function actualizarCalculosBCV() {
  const tasa = obtenerTasaBCV();
  const usuario = sessionStorage.getItem("factura_usuario") || "global";
  if (tasa > 0) {
    localStorage.setItem("tasa_bcv_user_" + usuario, tasa);
  }

  let totalUSD = 0;
  let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;
  for (let key in items) {
    totalUSD += parseFloat(items[key].precioTotal) || 0;
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

// PRODUCTO MANUAL
function abrirModalProductoManual() {
  document.getElementById('manualNombre').value = "";
  document.getElementById('manualPrecioUd').value = "";
  document.getElementById('manualCantUd').value = "1";
  document.getElementById('manualPrecioKg').value = "";
  document.getElementById('manualKg').value = "";
  document.getElementById('manualGramos').value = "";
  document.getElementById('manualModoVenta').value = "unidades";
  if (document.getElementById('manualIVA')) {
    document.getElementById('manualIVA').value = "E";
  }

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
  const tasaIVA = document.getElementById('manualIVA') ? document.getElementById('manualIVA').value : "E";
  const errorDiv = document.getElementById('errorModalManual');

  if (!nombre) {
    errorDiv.textContent = "Indique el nombre o descripción del producto.";
    errorDiv.classList.remove('hidden');
    return;
  }

  const modalProcesarEl = document.getElementById('modalProcesarFactura');
  const estaEnProceso = modalProcesarEl && modalProcesarEl.classList.contains('show');

  let destinoItems = estaEnProceso 
    ? (transaccionActiva ? transaccionActiva.items : itemsFactura)
    : itemsFactura;

  if (modo === "unidades") {
    let precioUd = parseFloat(document.getElementById('manualPrecioUd').value);
    let cant = parseInt(document.getElementById('manualCantUd').value);

    if (isNaN(precioUd) || precioUd <= 0 || isNaN(cant) || cant < 1) {
      errorDiv.textContent = "Indique precio unitario y cantidad válida.";
      errorDiv.classList.remove('hidden');
      return;
    }

    let calc = precioUd * cant;

    destinoItems[nombre] = {
      cantidadTxt: `${cant} uds`,
      cantNumerica: cant,
      pesoTotalGramos: 0,
      precioTotal: calc.toFixed(2),
      precioBase: precioUd,
      unidad: "unidades",
      minBase: 1,
      pesoPromedio: 0,
      tasaIVA: tasaIVA,
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

    destinoItems[nombre] = {
      cantidadTxt: cantTxt,
      cantNumerica: totalGramos,
      pesoTotalGramos: totalGramos,
      precioTotal: calc.toFixed(2),
      precioBase: precioKg,
      unidad: "gramos",
      minBase: 1,
      pesoPromedio: 0,
      tasaIVA: tasaIVA,
      imgPath: '../img/LOGO-MUNDO123.webp',
      esManual: true
    };
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProductoManual')).hide();

  if (estaEnProceso) {
    renderizarTablaModalFactura();
    actualizarCalculosBCV();
  } else {
    renderizarResumenFactura();
  }

  mostrarAvisoFactura(`Producto manual agregado: ${nombre}`);
}

// INICIO DE SESIÓN
async function procesarLoginFacturacion(event) {
  event.preventDefault();
  
  const usuario = document.getElementById('facUsuario').value.trim().toLowerCase();
  const password = document.getElementById('facPassword').value.trim();
  const btn = document.getElementById('btnIngresarFac');

  if (!usuario || !password) {
    return mostrarAvisoFactura("Ingrese usuario y contraseña.");
  }

  btn.disabled = true;
  btn.textContent = "Verificando...";

  try {
    const { data, error } = await supabaseClient.from('usuarios_factur').select('*');

    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema 🔐";

    if (!error && data) {
      const userFound = data.find(u => {
        const uNom = String(u["NOMBRE DE USUARIO"] || "").trim().toLowerCase();
        const uPass = String(u["CLAVE"] || "").trim();
        return (uNom === usuario || (usuario === "mayka" && uNom === "maika") || (usuario === "maika" && uNom === "mayka")) && uPass === password;
      });

      if (userFound) {
        const usuarioNormalizado = normalizarUsuario(userFound["NOMBRE DE USUARIO"]);
        let token = btoa(usuarioNormalizado + ":" + Date.now());
        sessionStorage.setItem("factura_token", token);
        sessionStorage.setItem("factura_usuario", usuarioNormalizado);
        iniciarModuloFacturacion(usuarioNormalizado);
        return;
      }
    }

    mostrarAvisoFactura("Usuario o contraseña incorrectos.");

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema 🔐";
    mostrarAvisoFactura("Error de conexión al autenticar con Supabase.");
  }
}

// APERTURA DE CAJA / BIENVENIDA AL INICIAR SESIÓN
function iniciarModuloFacturacion(usuario) {
  const userNorm = normalizarUsuario(usuario);
  document.getElementById('vistaLogin').classList.add('hidden');
  document.getElementById('vistaFacturacion').classList.remove('hidden');
  document.getElementById('usuarioActivo').textContent = `👤 ${userNorm.toUpperCase()}`;
  
  cargarCatalogoFacturacion();
  cargarMovimientosEfectivoPersistentes();
  inicializarModoFiscal();
  
  if (navigator.onLine) {
    sincronizarClientesDesdeServidor();
    procesarColaSincronizacion();
  }

  verificarYSolicitarAperturaCaja(userNorm);
}

function verificarYSolicitarAperturaCaja(userNorm) {
  const hoy = new Date().toISOString().split('T')[0];
  const claveApertura = `apertura_caja_user_${userNorm}_${hoy}`;
  const aperturaGuardada = localStorage.getItem(claveApertura);

  const tituloSaludo = document.getElementById('aperturaTituloSaludo');
  const msgMotivacion = document.getElementById('aperturaMensajeMotivacion');
  const inpUSD = document.getElementById('aperturaInicialUSD');
  const inpBS = document.getElementById('aperturaInicialBS');

  if (tituloSaludo) {
    tituloSaludo.textContent = `👋 ¡Bienvenido/a, ${userNorm.toUpperCase()}!`;
  }

  const frasesMotivacion = [
    "¡Que tengas una excelente y muy productiva jornada laboral! 🚀🥩",
    "¡Mucho éxito hoy! Gracias por tu dedicación y compromiso con Mundocarnes. ✨",
    "¡Comenzamos con la mejor energía para atender a todos nuestros clientes! 🏆",
    "¡Éxito en tus ventas hoy! Hagamos de esta jornada un gran día. 🌟"
  ];
  const fraseAleatoria = frasesMotivacion[Math.floor(Math.random() * frasesMotivacion.length)];
  if (msgMotivacion) msgMotivacion.textContent = fraseAleatoria;

  if (aperturaGuardada) {
    try {
      const datos = JSON.parse(aperturaGuardada);
      inpUSD.value = (parseFloat(datos.usd) || 0).toFixed(2);
      inpBS.value = (parseFloat(datos.bs) || 0).toFixed(2);
    } catch (e) {
      inpUSD.value = "0.00";
      inpBS.value = "0.00";
    }
  } else {
    inpUSD.value = "0.00";
    inpBS.value = "0.00";
  }

  document.getElementById('errorModalApertura').classList.add('hidden');
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAperturaCaja')).show();
}

function guardarAperturaCajaInicial() {
  const usuario = obtenerUsuarioActivo();
  const inpUSD = document.getElementById('aperturaInicialUSD');
  const inpBS = document.getElementById('aperturaInicialBS');
  const errorDiv = document.getElementById('errorModalApertura');

  const usd = parseFloat(inpUSD.value);
  const bs = parseFloat(inpBS.value);

  if (isNaN(usd) || usd < 0 || isNaN(bs) || bs < 0) {
    if (errorDiv) {
      errorDiv.textContent = "Por favor, indique montos válidos (0 o mayores) para la apertura.";
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  if (errorDiv) errorDiv.classList.add('hidden');

  const hoy = new Date().toISOString().split('T')[0];
  const claveApertura = `apertura_caja_user_${usuario}_${hoy}`;
  const registroApertura = {
    usd: usd,
    bs: bs,
    fechaHora: new Date().toLocaleString('es-VE')
  };

  localStorage.setItem(claveApertura, JSON.stringify(registroApertura));

  const elemCierreUSD = document.getElementById('cierreInicialUSD');
  const elemCierreBS = document.getElementById('cierreInicialBS');
  if (elemCierreUSD) elemCierreUSD.value = usd.toFixed(2);
  if (elemCierreBS) elemCierreBS.value = bs.toFixed(2);

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalAperturaCaja')).hide();
  mostrarAvisoFactura(`🚀 ¡Apertura de caja registrada! Saldo inicial: $${usd.toFixed(2)} / Bs.${bs.toFixed(2)}`, true, 6000);
}

function cerrarSesionFacturacion() {
  sessionStorage.removeItem("factura_token");
  sessionStorage.removeItem("factura_usuario");
  itemsFactura = {};
  transaccionActiva = null;
  facturasEnEspera = [];
  clienteFacturaActual = null;
  actualizarContadorStandby();
  document.getElementById('vistaFacturacion').classList.add('hidden');
  document.getElementById('vistaLogin').classList.remove('hidden');
  document.getElementById('facUsuario').value = "";
  document.getElementById('facPassword').value = "";
}

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
        <div id="lista-${safeId}" class="row g-2 pt-1"></div>
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
  const contenedor = document.getElementById(idElemento);
  if (!contenedor) return;

  contenedor.innerHTML = productos.map(f => {
    let nom = f[0];
    let prec = f[1];
    let imgPath = f[2].startsWith('../') ? f[2] : '../' + f[2];
    let esDisp = f[3];
    let cantMin = f[4];
    let unidad = f[5];
    let pesoPromedio = f[6] || 0;
    let tasaIVA = f[8] || "E";

    let claseImg = esDisp ? "" : "img-agotado";
    let boton = esDisp 
      ? `<button class="btn btn-sm btn-outline-danger fw-bold mt-2 w-100" onclick="abrirModalAgregarFactura('${nom}', ${prec}, '${nombreCategoria}', ${cantMin}, '${unidad}', ${pesoPromedio}, '${imgPath}', '${tasaIVA}')">+ Seleccionar</button>`
      : `<button class="btn btn-sm btn-secondary fw-bold mt-2 w-100" disabled>Agotado</button>`;

    let unidadTxt = (unidad === 'gramos') ? 'g' : 'uds';

    return `
      <div class="col-6 col-md-4 col-xl-3">
        <div class="card card-producto h-100 text-center">
          <img src="${imgPath}" loading="lazy" class="${claseImg}">
          <h6 class="fw-bold mt-2 text-truncate mb-1">${nom}</h6>
          <p class="text-success fw-bold mb-0 num-legible">$${parseFloat(prec).toFixed(2)}</p>
          <small class="text-muted" style="font-size:0.72rem;">Mín: ${cantMin} ${unidadTxt}</small>
          ${boton}
        </div>
      </div>`;
  }).join('');
}

function abrirModalAgregarFactura(nom, prec, cat, cantMin, unidad, pesoProm, imgPath, tasaIVA = "E") {
  productoTemporalFactura = { 
    nombre: nom, 
    precio: prec, 
    categoria: cat, 
    minBase: cantMin, 
    unidad: unidad, 
    pesoPromedio: pesoProm,
    imgPath: imgPath,
    tasaIVA: tasaIVA || "E"
  };

  document.getElementById('modalNombreProducto').textContent = nom;
  document.getElementById('modalPrecioProducto').textContent = `$${parseFloat(prec).toFixed(2)}`;

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
      tasaIVA: prod.tasaIVA || "E",
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
      tasaIVA: prod.tasaIVA || "E",
      imgPath: prod.imgPath || '../img/LOGO-MUNDO123.webp'
    };
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFacturaCantidad')).hide();
  renderizarResumenFactura();
}

function renderizarResumenFactura() {
  let html = '<table class="table table-sm align-middle text-start"><tbody>';

  for (let key in itemsFactura) {
    let item = itemsFactura[key];
    html += `
      <tr>
        <td class="fw-bold small text-wrap">${key}</td>
        <td class="small text-muted num-legible">${item.cantidadTxt}</td>
        <td class="text-danger fw-bold text-end num-legible">$${item.precioTotal}</td>
        <td class="text-end" style="width:24px">
          <button class="btn btn-sm btn-outline-danger py-0 px-1 border-0 fw-bold" onclick="eliminarItemFactura('${key}')">✕</button>
        </td>
      </tr>`;
  }

  html += '</tbody></table>';

  document.getElementById('contenedorListaFactura').innerHTML = Object.keys(itemsFactura).length 
    ? html 
    : '<p class="text-muted text-center py-4 small">No hay productos seleccionados.</p>';

  const tributos = calcularTotalesTributarios(itemsFactura);
  const elemExento = document.getElementById('montoResumenExento');
  const elemBase = document.getElementById('montoResumenBase');
  const elemIVA = document.getElementById('montoResumenIVA');

  if (elemExento) elemExento.textContent = `$${tributos.montoExento.toFixed(2)}`;
  if (elemBase) elemBase.textContent = `$${tributos.montoBase.toFixed(2)}`;
  if (elemIVA) elemIVA.textContent = `$${tributos.montoIVA.toFixed(2)}`;

  document.getElementById('montoTotalFactura').textContent = `$${tributos.totalGeneral.toFixed(2)}`;

  const tasa = obtenerTasaBCV();
  const elemBs = document.getElementById('montoTotalFacturaBs');
  if (elemBs) {
    let totalBs = tributos.totalGeneral * (tasa > 0 ? tasa : 1);
    elemBs.textContent = `Bs. ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

function eliminarItemFactura(nombre) {
  delete itemsFactura[nombre];
  renderizarResumenFactura();
}

function ejecutarFacturar() {
  if (Object.keys(itemsFactura).length === 0) {
    return mostrarAvisoFactura("Seleccione al menos un producto para facturar.");
  }

  const usuarioActivo = obtenerUsuarioActivo();

  transaccionActiva = {
    id: "tx_" + Date.now(),
    horaPausa: new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }),
    items: { ...itemsFactura },
    cliente: null,
    formaPago: "",
    tasaBCV: obtenerTasaBCV(),
    usuario: usuarioActivo,
    modoFiscal: modoFiscalActivo
  };

  itemsFactura = {};
  renderizarResumenFactura();

  monedaVistaModal = "USD";
  const btnConmutar = document.getElementById('btnConmutarMoneda');
  if (btnConmutar) {
    btnConmutar.textContent = "💱 Ver en Bolívares (Bs)";
    btnConmutar.className = "btn btn-sm btn-outline-dark fw-bold rounded-pill";
  }

  document.querySelectorAll('.btn-metodo-pago').forEach(b => b.classList.remove('active'));
  document.getElementById('facFormaPagoSelect').value = "";

  const contMixto = document.getElementById('contenedorPagoMixto');
  if (contMixto) contMixto.classList.add('hidden');

  const tasaGuardada = localStorage.getItem("tasa_bcv_user_" + usuarioActivo);
  const inputTasa = document.getElementById('facTasaBCV');
  if (inputTasa) {
    inputTasa.value = tasaGuardada ? tasaGuardada : "";
  }

  document.getElementById('facCedulaBuscar').value = "";
  document.getElementById('boxClienteEncontrado').classList.add('hidden');
  document.getElementById('boxClienteNuevo').classList.add('hidden');
  clienteFacturaActual = null;

  renderizarTablaModalFactura();
  actualizarInterfazModoFiscal();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).show();
  actualizarCalculosBCV();
}

// STANDBY / FACTURAS EN ESPERA
function ponerFacturaEnEspera() {
  if (!transaccionActiva || !transaccionActiva.items || Object.keys(transaccionActiva.items).length === 0) {
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();
    return;
  }

  transaccionActiva.cliente = clienteFacturaActual;
  transaccionActiva.formaPago = document.getElementById('facFormaPagoSelect') ? document.getElementById('facFormaPagoSelect').value : '';
  transaccionActiva.horaPausa = new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

  facturasEnEspera.push({ ...transaccionActiva });
  transaccionActiva = null;
  clienteFacturaActual = null;

  actualizarContadorStandby();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();
  mostrarAvisoFactura("⏸️ Factura puesta en espera correctamente.");
}

function actualizarContadorStandby() {
  const elem = document.getElementById('cntFacturasEnEspera');
  if (elem) elem.textContent = facturasEnEspera.length;
}

function abrirModalFacturasEnEspera() {
  renderizarTablaFacturasEnEspera();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFacturasEnEspera')).show();
}

function renderizarTablaFacturasEnEspera() {
  const tbody = document.getElementById('tablaFacturasEnEspera');
  if (!tbody) return;

  if (facturasEnEspera.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">No hay facturas en espera.</td></tr>`;
    return;
  }

  let html = "";
  facturasEnEspera.forEach((tx, idx) => {
    let cantProds = Object.keys(tx.items).length;
    let total = 0;
    for (let k in tx.items) total += parseFloat(tx.items[k].precioTotal) || 0;
    let clienteNom = tx.cliente ? tx.cliente.nombre : "Consumidor Final";

    html += `
      <tr>
        <td class="text-center fw-bold">${idx + 1}</td>
        <td class="text-center">${tx.horaPausa || 'N/D'}</td>
        <td class="fw-bold">${clienteNom}</td>
        <td class="text-center">${cantProds} producto(s)</td>
        <td class="text-end fw-bold text-success num-legible">$${total.toFixed(2)}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-success py-0 px-2 fw-bold rounded-pill me-1" onclick="reanudarFacturaEnEspera(${idx})">
            ▶️ Reanudar
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fw-bold rounded-pill" onclick="eliminarFacturaEnEspera(${idx})">
            🗑️
          </button>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

function reanudarFacturaEnEspera(idx) {
  if (idx < 0 || idx >= facturasEnEspera.length) return;

  transaccionActiva = facturasEnEspera.splice(idx, 1)[0];
  actualizarContadorStandby();

  clienteFacturaActual = transaccionActiva.cliente || null;

  if (clienteFacturaActual) {
    poblarClienteEnVista(clienteFacturaActual);
  } else {
    document.getElementById('boxClienteEncontrado').classList.add('hidden');
    document.getElementById('boxClienteNuevo').classList.add('hidden');
  }

  document.querySelectorAll('.btn-metodo-pago').forEach(b => b.classList.remove('active'));
  if (transaccionActiva.formaPago) {
    document.getElementById('facFormaPagoSelect').value = transaccionActiva.formaPago;
    const btnMetodo = document.querySelector(`.btn-metodo-pago[data-metodo="${transaccionActiva.formaPago}"]`);
    if (btnMetodo) btnMetodo.classList.add('active');
    evaluarFormaPagoFactura(transaccionActiva.formaPago);
  } else {
    document.getElementById('facFormaPagoSelect').value = "";
    document.getElementById('contenedorPagoMixto').classList.add('hidden');
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFacturasEnEspera')).hide();
  renderizarTablaModalFactura();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).show();
  actualizarCalculosBCV();

  mostrarAvisoFactura("▶️ Factura reanudada.");
}

function eliminarFacturaEnEspera(idx) {
  if (confirm("¿Está seguro de descartar esta factura en espera?")) {
    facturasEnEspera.splice(idx, 1);
    actualizarContadorStandby();
    renderizarTablaFacturasEnEspera();
    mostrarAvisoFactura("🗑️ Factura descartada.");
  }
}

// BÚSQUEDA Y ASIGNACIÓN DE CLIENTE
function seleccionarConsumidorFinal() {
  const clienteGenerico = {
    cedula: "V-00000000",
    nombre: "CONSUMIDOR FINAL",
    telefono: "N/D",
    direccion: "CIUDAD"
  };
  clienteFacturaActual = clienteGenerico;
  poblarClienteEnVista(clienteGenerico);
  mostrarAvisoFactura("⚡ Asignado: Consumidor Final (V-00000000)");
}

async function buscarClienteFactura() {
  const inputCedula = document.getElementById('facCedulaBuscar');
  const cedula = inputCedula ? inputCedula.value.trim().toUpperCase() : "";
  
  if (!cedula) {
    return mostrarAvisoFactura("Ingrese la Cédula o RIF.");
  }

  const btn = document.getElementById('btnBuscarClienteFac');
  if (btn) { btn.disabled = true; btn.textContent = "Buscando..."; }

  let clienteLocal = await dbGet("clientes", cedula);
  if (clienteLocal) {
    if (btn) { btn.disabled = false; btn.textContent = "🔍 Buscar"; }
    clienteFacturaActual = clienteLocal;
    poblarClienteEnVista(clienteLocal);
    mostrarAvisoFactura("Cliente localizado localmente ⚡");
    return;
  }

  if (navigator.onLine) {
    try {
      const { data: resSup, error } = await supabaseClient
        .from('clientes')
        .select('*')
        .eq('CEDULA', cedula)
        .maybeSingle();

      if (btn) { btn.disabled = false; btn.textContent = "🔍 Buscar"; }

      if (!error && resSup) {
        let cliObj = {
          cedula: resSup.CEDULA,
          nombre: resSup.NOMBRES || 'N/D',
          telefono: resSup.TELEFONO || 'N/D',
          direccion: resSup.DIRECCION || null
        };
        clienteFacturaActual = cliObj;
        await dbPut("clientes", cliObj);
        poblarClienteEnVista(cliObj);
        mostrarAvisoFactura("Cliente localizado con éxito en Supabase.");
        return;
      }
    } catch (err) {}
  }

  if (btn) { btn.disabled = false; btn.textContent = "🔍 Buscar"; }
  clienteFacturaActual = null;
  prepararNuevoClienteEnVista(cedula);
  mostrarAvisoFactura("Cliente no registrado. Complete los datos para crearlo.");
}

function poblarClienteEnVista(cli) {
  const elemCedula = document.getElementById('facClienteCedulaRead');
  const elemNombre = document.getElementById('facClienteNombreRead');
  const elemTel = document.getElementById('facClienteTelefonoRead');
  const elemDir = document.getElementById('facClienteDireccionRead');
  const chkEsp = document.getElementById('chkEsContribuyenteEspecial');
  const selPorc = document.getElementById('selectPorcentajeRetencion');

  if (elemCedula) elemCedula.value = cli.cedula || '';
  if (elemNombre) elemNombre.value = cli.nombre || 'N/D';
  if (elemTel) elemTel.value = cli.telefono || 'N/D';
  if (elemDir) elemDir.value = cli.direccion || '';

  const esEspecial = Boolean(cli.esContribuyenteEspecial || cli.ES_CONTRIBUYENTE_ESPECIAL);
  if (chkEsp) chkEsp.checked = esEspecial;
  if (selPorc) selPorc.value = String(cli.porcentajeRetencion || 75);

  const boxEncontrado = document.getElementById('boxClienteEncontrado');
  const boxNuevo = document.getElementById('boxClienteNuevo');
  if (boxEncontrado) boxEncontrado.classList.remove('hidden');
  if (boxNuevo) boxNuevo.classList.add('hidden');

  if (modoFiscalActivo) {
    alternarModuloRetencionIVA(esEspecial);
  } else {
    alternarModuloRetencionIVA(false);
  }
}

function prepararNuevoClienteEnVista(cedula) {
  const elemRegCedula = document.getElementById('facRegCedula');
  const elemRegNombre = document.getElementById('facRegNombre');
  const elemRegTel = document.getElementById('facRegTelefono');
  const elemRegDir = document.getElementById('facRegDireccion');
  const chkRegEsp = document.getElementById('chkRegEsContribuyenteEspecial');

  if (elemRegCedula) elemRegCedula.value = cedula.toUpperCase();
  if (elemRegNombre) elemRegNombre.value = "";
  if (elemRegTel) elemRegTel.value = "";
  if (elemRegDir) elemRegDir.value = "";
  if (chkRegEsp) chkRegEsp.checked = false;

  const boxEncontrado = document.getElementById('boxClienteEncontrado');
  const boxNuevo = document.getElementById('boxClienteNuevo');
  if (boxEncontrado) boxEncontrado.classList.add('hidden');
  if (boxNuevo) boxNuevo.classList.remove('hidden');

  alternarModuloRetencionIVA(false);
}

async function registrarClienteFactura() {
  const cedula = document.getElementById('facRegCedula').value.trim().toUpperCase();
  const nombre = document.getElementById('facRegNombre').value.trim().toUpperCase();
  const telefono = document.getElementById('facRegTelefono').value.trim();
  const direccion = document.getElementById('facRegDireccion').value.trim() || null;
  const esEspecial = Boolean(document.getElementById('chkRegEsContribuyenteEspecial')?.checked);
  const btn = document.getElementById('btnRegistrarClienteFac');

  if (!cedula || !nombre) {
    return mostrarAvisoFactura("Cédula y Nombre son obligatorios.");
  }

  if (btn) { btn.disabled = true; btn.textContent = "Registrando..."; }

  const clienteNuevo = { 
    cedula, 
    nombre, 
    telefono, 
    direccion,
    esContribuyenteEspecial: esEspecial,
    porcentajeRetencion: 75
  };
  clienteFacturaActual = clienteNuevo;

  await dbPut("clientes", clienteNuevo);
  poblarClienteEnVista(clienteNuevo);

  await dbPut("syncQueue", {
    id: "sync_cli_" + Date.now(),
    payload: {
      action: "registrarClienteFactura",
      cedula: cedula,
      nombre: nombre,
      telefono: telefono,
      direccion: direccion,
      esContribuyenteEspecial: esEspecial,
      porcentajeRetencion: 75
    }
  });

  if (btn) { btn.disabled = false; btn.textContent = "💾 Registrar Nuevo Cliente"; }

  mostrarAvisoFactura("Cliente registrado exitosamente ⚡");
  procesarColaSincronizacion();
}

// ==========================================================================
// MOTOR DE CÁLCULO DE RETENCIONES DE IVA E IGTF 3% (EXCLUSIVO MODO FISCAL)
// ==========================================================================
function alternarModuloRetencionIVA(activo) {
  const panel = document.getElementById('panelConfiguracionRetencionIVA');
  if (panel) {
    if (activo && modoFiscalActivo) panel.classList.remove('hidden');
    else panel.classList.add('hidden');
  }
  recalcularTotalesRetencionEIGTF();
}
window.alternarModuloRetencionIVA = alternarModuloRetencionIVA;

function validarLongitudComprobante(input) {
  input.value = input.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
window.validarLongitudComprobante = validarLongitudComprobante;

function recalcularTotalesRetencionEIGTF() {
  const contInfo = document.getElementById('contenedorLiquidacionFiscalInfo');
  const lblRet = document.getElementById('lblInfoRetencionIVA');
  const lblIGTF = document.getElementById('lblInfoIGTF3');

  if (!modoFiscalActivo) {
    if (contInfo) contInfo.classList.add('hidden');
    return { retencionUSD: 0, retencionBS: 0, igtfUSD: 0, igtfBS: 0, netoUSD: 0, netoBS: 0 };
  }

  const items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;
  const tributos = calcularTotalesTributarios(items, true);
  const factorTasa = obtenerTasaBCV() || 1;

  // 1. CÁLCULO DE RETENCIÓN DE IVA (75% / 100%)
  const chkEsp = document.getElementById('chkEsContribuyenteEspecial');
  const esEspecial = Boolean(chkEsp && chkEsp.checked);
  const porcRet = parseInt(document.getElementById('selectPorcentajeRetencion')?.value || "75", 10);

  let retencionIVA_USD = 0;
  let retencionIVA_BS = 0;

  if (esEspecial && tributos.montoIVA > 0) {
    retencionIVA_USD = parseFloat((tributos.montoIVA * (porcRet / 100)).toFixed(2));
    retencionIVA_BS = parseFloat((retencionIVA_USD * factorTasa).toFixed(2));
  }

  // 2. CÁLCULO DE PERCEPCIÓN DE IGTF (3% SOBRE MEDIOS EN DIVISAS)
  const chkIGTF = document.getElementById('chkPercibirIGTF3');
  const aplicaIGTF = Boolean(chkIGTF && chkIGTF.checked);
  const formaSelect = document.getElementById('facFormaPagoSelect')?.value || "";

  let baseImponibleIGTF_USD = 0;

  if (aplicaIGTF) {
    if (formaSelect === 'Efectivo Divisas' || formaSelect === 'Zelle' || formaSelect === 'PayPal') {
      baseImponibleIGTF_USD = tributos.totalGeneral - retencionIVA_USD;
    } else if (formaSelect === 'Pago Mixto' || formaSelect === 'Cashea') {
      const filas = document.querySelectorAll('.fila-pago-mixto');
      filas.forEach(f => {
        let met = f.querySelector('.select-metodo-mixto')?.value || "";
        let mto = parseFloat(f.querySelector('.input-monto-mixto')?.value) || 0;
        if (METODOS_USD.includes(met) && met !== 'Crédito' && met !== 'Cashea') {
          baseImponibleIGTF_USD += mto;
        }
      });
    }
  }

  let montoIGTF_USD = 0;
  let montoIGTF_BS = 0;

  if (baseImponibleIGTF_USD > 0) {
    montoIGTF_USD = parseFloat((baseImponibleIGTF_USD * 0.03).toFixed(2));
    montoIGTF_BS = parseFloat((montoIGTF_USD * factorTasa).toFixed(2));
  }

  // 3. TOTAL NETO A PERCIBIR EN CAJA
  const totalNetoUSD = parseFloat((tributos.totalGeneral - retencionIVA_USD + montoIGTF_USD).toFixed(2));
  const totalNetoBS = parseFloat(((tributos.totalGeneral * factorTasa) - retencionIVA_BS + montoIGTF_BS).toFixed(2));

  // Actualización visual
  if (retencionIVA_USD > 0 || montoIGTF_USD > 0) {
    if (contInfo) contInfo.classList.remove('hidden');

    if (lblRet) {
      if (retencionIVA_USD > 0) {
        lblRet.classList.remove('hidden');
        const elemPorc = document.getElementById('txtPorcRetencion');
        const elemRetUSD = document.getElementById('txtMontoRetenidoUSD');
        const elemRetBS = document.getElementById('txtMontoRetenidoBS');
        if (elemPorc) elemPorc.textContent = porcRet;
        if (elemRetUSD) elemRetUSD.textContent = `$${retencionIVA_USD.toFixed(2)}`;
        if (elemRetBS) elemRetBS.textContent = `Bs. ${retencionIVA_BS.toLocaleString('es-VE', { minimumFractionDigits: 2 })}`;
      } else {
        lblRet.classList.add('hidden');
      }
    }

    if (lblIGTF) {
      if (montoIGTF_USD > 0) {
        lblIGTF.classList.remove('hidden');
        const elemIgtfUSD = document.getElementById('txtMontoIGTFUSD');
        const elemIgtfBS = document.getElementById('txtMontoIGTFBS');
        if (elemIgtfUSD) elemIgtfUSD.textContent = `$${montoIGTF_USD.toFixed(2)}`;
        if (elemIgtfBS) elemIgtfBS.textContent = `Bs. ${montoIGTF_BS.toLocaleString('es-VE', { minimumFractionDigits: 2 })}`;
      } else {
        lblIGTF.classList.add('hidden');
      }
    }

    const elemNetoUSD = document.getElementById('txtMontoNetoAPagarUSD');
    const elemNetoBS = document.getElementById('txtMontoNetoAPagarBS');
    if (elemNetoUSD) elemNetoUSD.textContent = `$${totalNetoUSD.toFixed(2)}`;
    if (elemNetoBS) elemNetoBS.textContent = `Bs. ${totalNetoBS.toLocaleString('es-VE', { minimumFractionDigits: 2 })}`;
  } else {
    if (contInfo) contInfo.classList.add('hidden');
  }

  return {
    retencionUSD: retencionIVA_USD,
    retencionBS: retencionIVA_BS,
    porcentajeRetencion: porcRet,
    esEspecial: esEspecial,
    igtfUSD: montoIGTF_USD,
    igtfBS: montoIGTF_BS,
    netoUSD: totalNetoUSD,
    netoBS: totalNetoBS
  };
}
window.recalcularTotalesRetencionEIGTF = recalcularTotalesRetencionEIGTF;

// SELECCIÓN DE FORMA DE PAGO CON AUTO-DETECCIÓN DE IGTF 3% EN DIVISAS
function seleccionarMetodoPagoBoton(metodo, btnElem) {
  document.querySelectorAll('.btn-metodo-pago').forEach(b => b.classList.remove('active'));
  if (btnElem) btnElem.classList.add('active');

  document.getElementById('facFormaPagoSelect').value = metodo;

  // Auto-activar o auto-desactivar el interruptor de IGTF (3% Divisas) en Modo Fiscal
  const chkIGTF = document.getElementById('chkPercibirIGTF3');
  if (chkIGTF && modoFiscalActivo) {
    const metodosDivisasIGTF = ["Efectivo Divisas", "Zelle", "PayPal"];
    if (metodosDivisasIGTF.includes(metodo)) {
      chkIGTF.checked = true;
    } else if (metodo !== "Pago Mixto" && metodo !== "Cashea") {
      chkIGTF.checked = false;
    }
  }

  evaluarFormaPagoFactura(metodo);
  recalcularTotalesRetencionEIGTF();
}

function evaluarFormaPagoFactura(valor) {
  const contMixto = document.getElementById('contenedorPagoMixto');
  const btnAgregar = document.getElementById('btnAgregarLineaMixto');
  const lista = document.getElementById('listaFilasPagoMixto');
  const titulo = document.getElementById('tituloDesglosePago');

  if (!contMixto) return;

  if (!valor) {
    contMixto.classList.add('hidden');
    return;
  }

  if (valor === 'Cashea') {
    contMixto.classList.remove('hidden');
    if (titulo) titulo.textContent = "🔀 Desglose de Pago Cashea:";
    if (btnAgregar) btnAgregar.classList.add('hidden');
    if (lista) lista.innerHTML = "";

    agregarLineaPagoMixtoFija("Cashea", false);
    agregarLineaPagoMixto();
    calcularTotalPagoMixto();

  } else if (valor === 'Pago Mixto') {
    contMixto.classList.remove('hidden');
    if (titulo) titulo.textContent = "🔀 Desglose de Pago Mixto:";
    if (btnAgregar) btnAgregar.classList.remove('hidden');
    if (lista) lista.innerHTML = "";

    agregarLineaPagoMixto();
    agregarLineaPagoMixto();
    calcularTotalPagoMixto();

  } else {
    contMixto.classList.add('hidden');
  }
}

function actualizarPrefijoFilaMixta(selectElem) {
  const fila = selectElem.closest('.fila-pago-mixto');
  if (!fila) return;
  const prefijoSpan = fila.querySelector('.simbolo-moneda-mixto');
  if (!prefijoSpan) return;

  const metodo = selectElem.value;
  if (METODOS_BS.includes(metodo)) {
    prefijoSpan.textContent = "Bs";
    prefijoSpan.className = "input-group-text simbolo-moneda-mixto bg-warning text-dark fw-bold";
  } else {
    prefijoSpan.textContent = "$";
    prefijoSpan.className = "input-group-text simbolo-moneda-mixto bg-light text-dark fw-bold";
  }
}

function agregarLineaPagoMixtoFija(metodoPredeterminado, esEliminable = true) {
  const lista = document.getElementById('listaFilasPagoMixto');
  if (!lista) return;

  const divFila = document.createElement('div');
  divFila.className = 'row g-2 mb-2 align-items-center fila-pago-mixto';

  const opciones = [
    "Cashea", "Crédito", "Efectivo Divisas", "Efectivo Bolívares", "Pago Móvil", 
    "Zelle", "PayPal", "Punto de Venta", "Transferencia Bancaria", "Biopago"
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
      <select class="form-select form-select-sm select-metodo-mixto" onchange="actualizarPrefijoFilaMixta(this); calcularTotalPagoMixto();" ${disabledAttr}>
        ${selectOptions}
      </select>
    </div>
    <div class="col-4">
      <div class="input-group input-group-sm">
        <span class="input-group-text simbolo-moneda-mixto ${prefijoClass}">${prefijoTxt}</span>
        <input type="number" class="form-control input-monto-mixto text-center fw-bold num-legible" step="0.01" min="0" placeholder="0.00" oninput="calcularTotalPagoMixto()">
      </div>
    </div>
    <div class="col-2 text-end">
      ${botonAccion}
    </div>
  `;

  lista.appendChild(divFila);
}

function agregarLineaPagoMixto() {
  const lista = document.getElementById('listaFilasPagoMixto');
  if (!lista) return;
  
  const divFila = document.createElement('div');
  divFila.className = 'row g-2 mb-2 align-items-center fila-pago-mixto';

  divFila.innerHTML = `
    <div class="col-6">
      <select class="form-select form-select-sm select-metodo-mixto" onchange="actualizarPrefijoFilaMixta(this); calcularTotalPagoMixto();">
        <option value="" disabled selected>-- Método --</option>
        <option value="Efectivo Divisas">Efectivo Divisas</option>
        <option value="Efectivo Bolívares">Efectivo Bolívares</option>
        <option value="Pago Móvil">Pago Móvil</option>
        <option value="Zelle">Zelle</option>
        <option value="PayPal">PayPal</option>
        <option value="Cashea">Cashea</option>
        <option value="Crédito">Crédito</option>
        <option value="Punto de Venta">Punto de Venta</option>
        <option value="Transferencia Bancaria">Transferencia Bancaria</option>
        <option value="Biopago">Biopago</option>
      </select>
    </div>
    <div class="col-4">
      <div class="input-group input-group-sm">
        <span class="input-group-text simbolo-moneda-mixto bg-light fw-bold">$</span>
        <input type="number" class="form-control input-monto-mixto text-center fw-bold num-legible" step="0.01" min="0" placeholder="0.00" oninput="calcularTotalPagoMixto()">
      </div>
    </div>
    <div class="col-2 text-end">
      <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 border-0 fw-bold" onclick="eliminarLineaPagoMixto(this)">✕</button>
    </div>
  `;

  lista.appendChild(divFila);
  calcularTotalPagoMixto();
}

function eliminarLineaPagoMixto(btn) {
  const lista = document.getElementById('listaFilasPagoMixto');
  if (lista && lista.children.length <= 1) {
    return mostrarAvisoFactura("El Desglose de Pago requiere al menos una forma de pago.");
  }
  btn.closest('.fila-pago-mixto').remove();
  calcularTotalPagoMixto();
}

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
  let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

  for (let key in items) {
    totalFacturaUSD += parseFloat(items[key].precioTotal) || 0;
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
      elemRestante.className = (restanteBs === 0) ? 'text-success fw-bold num-legible' : (restanteBs > 0 ? 'monto-restante-alerta num-legible' : 'text-danger fw-bold num-legible');
    }

  } else {
    if (elemAsignado) elemAsignado.textContent = `$${sumaAsignadaUSD.toFixed(2)}`;
    if (elemEsperado) elemEsperado.textContent = `$${totalFacturaUSD.toFixed(2)}`;

    if (elemRestante) {
      elemRestante.textContent = `$${restanteUSD.toFixed(2)}`;
      elemRestante.className = (restanteUSD === 0) ? 'text-success fw-bold num-legible' : (restanteUSD > 0 ? 'monto-restante-alerta num-legible' : 'text-danger fw-bold num-legible');
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

function obtenerDetalleFormaPagoFinal() {
  const formaSelect = document.getElementById('facFormaPagoSelect').value;
  if (!formaSelect) return null;

  if (formaSelect === 'Pago Mixto' || formaSelect === 'Cashea') {
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

// EMITIR FACTURA (DUAL: FISCAL PP9 PLUS/HKA80 VS NO FISCAL XP-80C)
async function emitirFacturaFinal() {
  if (!clienteFacturaActual) {
    return mostrarAvisoFactura("Debe buscar o registrar un cliente antes de emitir.");
  }

  if (modoFiscalActivo && (!clienteFacturaActual.cedula || clienteFacturaActual.cedula === "V-00000000")) {
    const continuarGenerico = confirm("Emitirá una FACTURA FISCAL a nombre de 'Consumidor Final'. ¿Desea continuar?");
    if (!continuarGenerico) return;
  }

  const formaPagoStr = obtenerDetalleFormaPagoFinal();
  if (!formaPagoStr) return;

  const btn = document.getElementById('btnEmitirFacturaFinal');
  if (btn) { btn.disabled = true; btn.textContent = "Preparando Emisión..."; }

  try {
    let numFactura = "";
    if (modoFiscalActivo) {
      // Calcular el siguiente correlativo fiscal real según el hardware y el historial
      let ultNum = 0;
      if (window.fiscalDriver?.ultimoReporteStatus?.ultimaFactura) {
        ultNum = parseInt(window.fiscalDriver.ultimoReporteStatus.ultimaFactura, 10) || 0;
      }
      if (ultNum === 0) {
        (cacheHistorialFacturas || []).forEach(f => {
          let numStr = String(f.numFactura || "").replace(/\D/g, '');
          if (/^\d{1,8}$/.test(numStr) && Boolean(f.esFiscal || String(f.formaPagoStr || "").includes("FISCAL"))) {
            let n = parseInt(numStr, 10) || 0;
            if (n > ultNum) ultNum = n;
          }
        });
      }
      numFactura = String(ultNum + 1).padStart(8, '0');
    } else {
      numFactura = await obtenerSiguienteCorrelativoLocal();
    }

    const tasa = obtenerTasaBCV();
    const factorTasa = tasa > 0 ? tasa : 1;
    let productosSummaryList = [];
    let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

    for (let key in items) {
      let item = items[key];
      const tasaTag = modoFiscalActivo ? ` (${(item.tasaIVA || "E").toUpperCase()})` : "";
      productosSummaryList.push(`${key}${tasaTag} (${item.cantidadTxt}) - $${item.precioTotal}`);
    }

    const tributos = calcularTotalesTributarios(items, modoFiscalActivo);
    let totalBs = tributos.totalGeneral * (tasa > 0 ? tasa : 1);
    const usuarioActivo = obtenerUsuarioActivo();
    const tablaPersonal = obtenerTablaVentasUsuario(usuarioActivo);

    // Liquidación fiscal de retenciones e IGTF (solo si modoFiscalActivo === true)
    const liquidacionFiscal = recalcularTotalesRetencionEIGTF();
    const nroCompRet = document.getElementById('inputNroComprobanteRetencion')?.value.trim() || "";

    datosFacturaPendiente = {
      numFactura: numFactura,
      fechaStr: new Date().toLocaleString('es-VE'),
      cliente: clienteFacturaActual,
      formaPagoStr: formaPagoStr,
      desglosePagos: obtenerObjetoDesgloseMetodos(),
      totalUSD: tributos.totalGeneral,
      totalBs: totalBs,
      montoExento: tributos.montoExento,
      montoBase: tributos.montoBase,
      montoIVA: tributos.montoIVA,
      tasaBCV: tasa,
      monedaVistaModal: monedaVistaModal,
      productosSummary: productosSummaryList.join(' | '),
      usuario: usuarioActivo,
      tablaVentas: tablaPersonal,
      modoFiscal: modoFiscalActivo,
      items: items,
      // Metadata Fiscal Especial
      esContribuyenteEspecial: Boolean(liquidacionFiscal.esEspecial && modoFiscalActivo),
      porcentajeRetencion: liquidacionFiscal.esEspecial ? liquidacionFiscal.porcentajeRetencion : 0,
      comprobanteRetencion: nroCompRet,
      montoRetencionUSD: liquidacionFiscal.retencionUSD,
      montoRetencionBS: liquidacionFiscal.retencionBS,
      montoIGTF_USD: liquidacionFiscal.igtfUSD,
      montoIGTF_BS: liquidacionFiscal.igtfBS,
      totalNetoCobradoUSD: liquidacionFiscal.netoUSD > 0 ? liquidacionFiscal.netoUSD : tributos.totalGeneral,
      totalNetoCobradoBS: liquidacionFiscal.netoBS > 0 ? liquidacionFiscal.netoBS : totalBs
    };

    renderizarTicketTermicoHTML(datosFacturaPendiente);

    const modeloTag = window.fiscalDriver ? window.fiscalDriver.modelo : "Fiscal";
    if (btn) { btn.disabled = false; btn.textContent = modoFiscalActivo ? `🧾 Emitir Factura Fiscal (${modeloTag})` : "🧾 Emitir Factura"; }

    const alertModal = document.getElementById('mensajeAlertaConfirmacionEmision');
    if (alertModal) {
      const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "la impresora fiscal";
      alertModal.textContent = modoFiscalActivo 
        ? `⚠️ ¿Está seguro de emitir esta FACTURA FISCAL en ${nombreModelo}?` 
        : "¿Está seguro de que desea registrar y emitir esta factura de control interno?";
    }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalVistaPreviaFactura')).show();

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "🧾 Emitir Factura"; }
    console.error("Error al generar venta local:", err);
    mostrarAvisoFactura("Error al preparar la factura.");
  }
}

function renderizarTicketTermicoHTML(d) {
  const emp = obtenerDatosEmpresa();
  const serialFiscal = obtenerSerialFiscalActivo();
  let tasa = d.tasaBCV || 1;
  let items = d.items || ((transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura);
  let ticketHtml = "";

  if (d.modoFiscal) {
    // =========================================================================
    // MODALIDAD FISCAL: DISEÑO EXACTO ACLAS PP9 PLUS (IDÉNTICO AL TICKET FÍSICO)
    // =========================================================================
    const fechaActual = new Date();
    const dia = String(fechaActual.getDate()).padStart(2, '0');
    const mes = String(fechaActual.getMonth() + 1).padStart(2, '0');
    const anio = fechaActual.getFullYear();
    const hora = String(fechaActual.getHours()).padStart(2, '0');
    const min = String(fechaActual.getMinutes()).padStart(2, '0');
    const fechaPP9 = `${dia}-${mes}-${anio}`;
    const horaPP9 = `${hora}:${min}`;
    const numFacturaPP9 = String(d.numFactura || "00000001").replace(/\D/g, '').slice(-8).padStart(8, '0');

    let renglonesFiscalesHtml = "";
    let totExentoBs = 0;
    let totBase16Bs = 0;
    let totIVA16Bs = 0;
    let totGeneralBs = 0;

    for (let key in items) {
      let item = items[key];
      let tasaLetra = (item.tasaIVA || "E").toUpperCase();
      let precioUSD = parseFloat(item.precioBase) || 0;
      let totalUSD = parseFloat(item.precioTotal) || 0;
      let precioUnitBs = precioUSD * tasa;
      let itemTotalBs = totalUSD * tasa;

      let factorIVA = (tasaLetra === "G" || tasaLetra === "16") ? 1.16 : 1.0;
      let baseImponibleBs = itemTotalBs / factorIVA;
      let ivaBs = itemTotalBs - baseImponibleBs;

      if (tasaLetra === "G" || tasaLetra === "16") {
        totBase16Bs += baseImponibleBs;
        totIVA16Bs += ivaBs;
      } else {
        totExentoBs += itemTotalBs;
      }
      totGeneralBs += itemTotalBs;

      let esPesa = (item.unidad === 'gramos' || item.unidad === 'mixto');
      let cantNumerica = parseFloat(item.cantNumerica) || 1;

      if (esPesa) {
        let kgCant = (cantNumerica >= 100 ? (cantNumerica / 1000) : cantNumerica).toFixed(3).replace('.', ',');
        renglonesFiscalesHtml += `
          <div class="pp9-linea-multiplicador">${kgCant}xBs ${precioUnitBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="pp9-fila-item">
            <span class="pp9-item-nombre">${key} (${tasaLetra})</span>
            <span class="pp9-item-monto">Bs ${itemTotalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>`;
      } else if (cantNumerica > 1) {
        renglonesFiscalesHtml += `
          <div class="pp9-linea-multiplicador">${cantNumerica}x Bs ${precioUnitBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div class="pp9-fila-item">
            <span class="pp9-item-nombre">${key} (${tasaLetra})</span>
            <span class="pp9-item-monto">Bs ${itemTotalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>`;
      } else {
        renglonesFiscalesHtml += `
          <div class="pp9-fila-item">
            <span class="pp9-item-nombre">${key} (${tasaLetra})</span>
            <span class="pp9-item-monto">Bs ${itemTotalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>`;
      }
    }

    let bloqueResumenFiscal = "";
    if (totExentoBs > 0) {
      bloqueResumenFiscal += `
        <div class="pp9-fila-item">
          <span>EXENTO</span>
          <span>Bs ${totExentoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>`;
    }
    if (totBase16Bs > 0) {
      bloqueResumenFiscal += `
        <div class="pp9-fila-item">
          <span>BI G (16,00%)</span>
          <span>Bs ${totBase16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div class="pp9-fila-item">
          <span>IVA G (16,00%)</span>
          <span>Bs ${totIVA16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>`;
    }

    // Cálculo y adición del IGTF 3% y Retención al Total Final
    const montoIGTF_BS = parseFloat(d.montoIGTF_BS || d.MONTO_IGTF_BS) || 0;
    const montoRetencion_BS = parseFloat(d.montoRetencionBS || d.MONTO_RETENCION_BS) || 0;
    const totalFinalTicketBs = d.totalNetoCobradoBS || (totGeneralBs + montoIGTF_BS - montoRetencion_BS);

    let renglonesAjusteFiscal = "";
    if (montoRetencion_BS > 0) {
      renglonesAjusteFiscal += `
        <div class="pp9-fila-item">
          <span>(-) RETENCION IVA (${d.porcentajeRetencion || 75}%)</span>
          <span>-Bs ${montoRetencion_BS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>`;
    }
    if (montoIGTF_BS > 0) {
      renglonesAjusteFiscal += `
        <div class="pp9-fila-item">
          <span>(+) IGTF PERCIBIDO (3,00%)</span>
          <span>Bs ${montoIGTF_BS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>`;
    }

    let bloqueIGTFHtml = "";
    if (montoIGTF_BS > 0) {
      bloqueIGTFHtml = `<div>IG.. 3 BS ${montoIGTF_BS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>`;
    }

    let bloqueCompRetHtml = "";
    if (d.comprobanteRetencion) {
      bloqueCompRetHtml = `<div>COMP RET ${d.comprobanteRetencion}</div>`;
    }

    let cedulaCliente = String(d.cliente.cedula || "V-00000000").trim();
    if (!/^[VJEGPvjegp]/i.test(cedulaCliente)) cedulaCliente = "V-" + cedulaCliente;

    // Etiqueta del medio de pago en ticket
    let nombreFormaPagoTicket = "EFECTIVO 1";
    let formaUpper = String(d.formaPagoStr || "").toUpperCase();
    if (formaUpper.includes("ZELLE")) nombreFormaPagoTicket = "ZELLE";
    else if (formaUpper.includes("PUNTO DE VENTA") || formaUpper.includes("DEBITO")) nombreFormaPagoTicket = "TARJETA DEBITO";
    else if (formaUpper.includes("CREDITO") || formaUpper.includes("CRÉDITO")) nombreFormaPagoTicket = "TARJETA CREDITO";
    else if (formaUpper.includes("PAGO MOVIL") || formaUpper.includes("PAGO MÓVIL")) nombreFormaPagoTicket = "PAGO MOVIL";
    else if (formaUpper.includes("PAYPAL")) nombreFormaPagoTicket = "PAYPAL";
    else if (formaUpper.includes("CASHEA")) nombreFormaPagoTicket = "CASHEA";
    else if (formaUpper.includes("BIOPAGO")) nombreFormaPagoTicket = "BIOPAGO";
    else if (formaUpper.includes("DIVISAS") || formaUpper.includes("DOLARES")) nombreFormaPagoTicket = "EFECTIVO DIVISAS";

    ticketHtml = `
      <div class="ticket-pp9-wrapper">
        <div class="pp9-header text-center">
          <div class="pp9-bold">SENIAT</div>
          <div class="pp9-bold">${emp.rif}</div>
          <div class="pp9-bold">${emp.nombre}</div>
          <div>${emp.direccion1}</div>
          <div>${emp.direccion2}</div>
          <div>${emp.direccion3}</div>
        </div>

        <div class="pp9-cliente-bloque">
          <div>RIF/CI:${cedulaCliente}</div>
          <div>R.S.:${String(d.cliente.nombre || 'CONSUMIDOR FINAL').toUpperCase()}</div>
          <div>${String(d.cliente.direccion || 'CARACAS').toUpperCase()}</div>
          <div>${d.cliente.telefono || 'N/D'}</div>
          ${bloqueCompRetHtml}
          ${bloqueIGTFHtml}
        </div>

        <div class="pp9-titulo-doc text-center">FACTURA</div>
        <div class="pp9-info-doc">
          <div class="pp9-fila-item">
            <span>FACTURA:</span>
            <span class="pp9-bold">${numFacturaPP9}</span>
          </div>
          <div class="pp9-fila-item">
            <span>FECHA: ${fechaPP9}</span>
            <span>HORA: ${horaPP9}</span>
          </div>
        </div>

        <div class="pp9-separator-dashed"></div>

        <div class="pp9-cuerpo-items">
          ${renglonesFiscalesHtml}
        </div>

        <div class="pp9-separator-dashed"></div>

        <div class="pp9-totales-bloque">
          ${bloqueResumenFiscal}
          ${renglonesAjusteFiscal}
          <div class="pp9-separator-dashed"></div>
          <div class="pp9-fila-item">
            <span>${nombreFormaPagoTicket}</span>
            <span>Bs ${totalFinalTicketBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div class="pp9-fila-item pp9-bold mt-1">
            <span>TOTAL</span>
            <span>Bs ${totalFinalTicketBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        </div>

        <div class="pp9-footer d-flex justify-content-between mt-2">
          <span>MH</span>
          <span class="pp9-bold">${serialFiscal}</span>
        </div>
      </div>
    `;

  } else {
    // =========================================================================
    // MODALIDAD NO FISCAL: NOTA DE ENTREGA CONTROL INTERNO XP-80C (INTACTO)
    // =========================================================================
    let filasProductosHtml = "";
    let i = 1;
    let esModoBs = (d.monedaVistaModal === "BS");

    for (let key in items) {
      let item = items[key];
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
          <td style="width:42%;" class="fw-bold">${key}</td>
          <td style="width:20%;" class="text-center num-legible">${precUnit}</td>
          <td style="width:16%;" class="text-center num-legible">${item.cantidadTxt}</td>
          <td style="width:16%;" class="text-end fw-bold num-legible">${itemTotalTxt}</td>
        </tr>`;
    }

    let bloqueTotalesHtml = esModoBs ? `
      <div class="d-flex justify-content-between">
        <span>TOTAL A PAGAR (Bs):</span>
        <strong class="fs-6 num-legible">Bs. ${d.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
      </div>
      <div class="d-flex justify-content-between text-muted">
        <span>TOTAL REF ($):</span>
        <span class="num-legible">$${d.totalUSD.toFixed(2)}</span>
      </div>` : `
      <div class="d-flex justify-content-between">
        <span>TOTAL A PAGAR ($):</span>
        <strong class="fs-6 num-legible">$${d.totalUSD.toFixed(2)}</strong>
      </div>
      <div class="d-flex justify-content-between text-muted">
        <span>TOTAL REF (Bs):</span>
        <span class="num-legible">Bs. ${d.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>`;

    ticketHtml = `
      <div class="ticket-container shadow-sm border text-start">
        <div class="ticket-header text-center">
          <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
          <div class="ticket-title fs-6">COMPROBANTE NO FISCAL - NOTA DE ENTREGA</div>
          <div>RIF: J-505072889 | TELF: 0412-1753275</div>
          <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
          <div>HORARIO: 7:30am - 19:00pm</div>
        </div>

        <div class="ticket-info">
          <div><strong>NRO CONTROL:</strong> <span class="fs-6 num-legible">${d.numFactura}</span></div>
          <div><strong>FECHA:</strong> <span class="num-legible">${d.fechaStr}</span></div>
          <div><strong>CLIENTE:</strong> ${d.cliente.nombre}</div>
          <div><strong>CI/RIF:</strong> <span class="num-legible">${d.cliente.cedula}</span> | <strong>TELF:</strong> <span class="num-legible">${d.cliente.telefono || 'N/D'}</span></div>
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

        <div class="ticket-footer text-center mt-3">
          <div>¡Gracias por su preferencia!</div>
        </div>
      </div>
    `;
  }

  const elemModal = document.getElementById('vistaPreviaTicketModal');
  if (elemModal) elemModal.innerHTML = ticketHtml;
}

function obtenerObjetoDesgloseMetodos() {
  const formaSelect = document.getElementById('facFormaPagoSelect').value;
  const tasa = obtenerTasaBCV();

  let desgl = {
    "Efectivo Divisas": 0, "Efectivo Bolívares": 0, "Pago Móvil": 0,
    "Zelle": 0, "PayPal": 0, "Cashea": 0, "Crédito": 0, "Punto de Venta": 0,
    "Transferencia Bancaria": 0, "Biopago": 0
  };

  let totalUSD = 0;
  let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

  for (let key in items) {
    totalUSD += parseFloat(items[key].precioTotal) || 0;
  }
  let totalBs = totalUSD * (tasa > 0 ? tasa : 1);

  if (formaSelect === 'Pago Mixto' || formaSelect === 'Cashea') {
    const filas = document.querySelectorAll('.fila-pago-mixto');
    filas.forEach(f => {
      let metodo = f.querySelector('.select-metodo-mixto').value;
      let montoTipado = parseFloat(f.querySelector('.input-monto-mixto').value) || 0;
      if (metodo && montoTipado > 0) {
        desgl[metodo] = (desgl[metodo] || 0) + montoTipado;
      }
    });
  } else {
    if (METODOS_BS.includes(formaSelect)) {
      desgl[formaSelect] = parseFloat(totalBs.toFixed(2));
    } else {
      desgl[formaSelect] = parseFloat(totalUSD.toFixed(2));
    }
  }

  return desgl;
}

async function confirmarEImprimirFactura() {
  if (!datosFacturaPendiente) return;

  const btn = document.getElementById('btnConfirmarEmisionFinal');
  if (btn) { btn.disabled = true; btn.textContent = "Procesando Emisión..."; }

  try {
    let numFactura = datosFacturaPendiente.numFactura;
    let numFacturaFiscalEmitida = null;
    const usuarioActivo = obtenerUsuarioActivo();

    // 1. SI EL MODO FISCAL ESTÁ ACTIVADO: Transmitir a la impresora fiscal seleccionada (HKA80 / PP9)
    if (datosFacturaPendiente.modoFiscal) {
      const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "Fiscal";
      if (!window.fiscalDriver || !window.fiscalDriver.conectado) {
        const intentarConectar = confirm(`La impresora fiscal ${nombreModelo} no está conectada. ¿Desea conectarla ahora?`);
        if (intentarConectar) {
          await window.fiscalDriver.solicitarYConectar();
        } else {
          if (btn) { btn.disabled = false; btn.textContent = "🖨️ Confirmar y Emitir"; }
          return;
        }
      }

      const resFiscal = await window.fiscalDriver.emitirFacturaFiscal(datosFacturaPendiente);
      numFacturaFiscalEmitida = resFiscal.numFacturaFiscal;
      numFactura = numFacturaFiscalEmitida || numFactura;
    } else {
      // 2. MODO NO FISCAL / CONTROL INTERNO: Imprimir vía ticketera convencional XP-80C
      const ticketHtml = document.getElementById('vistaPreviaTicketModal').innerHTML;
      ejecutarImpresionTicket(ticketHtml);
    }

    const esFiscalActivo = Boolean(datosFacturaPendiente.modoFiscal);
    let formaPagoFinalStr = datosFacturaPendiente.formaPagoStr || "EFECTIVO";
    if (esFiscalActivo && !formaPagoFinalStr.toUpperCase().includes("FISCAL")) {
      formaPagoFinalStr = `${formaPagoFinalStr} (FISCAL)`;
    }

    // 3. Guardar en IndexedDB local con liquidación de Retenciones e IGTF
    await dbPut("ventas", {
      numFactura: String(numFactura),
      fechaStr: datosFacturaPendiente.fechaStr,
      montoTotalUSD: datosFacturaPendiente.totalUSD,
      cedula: datosFacturaPendiente.cliente.cedula,
      nombre: datosFacturaPendiente.cliente.nombre,
      direccion: datosFacturaPendiente.cliente.direccion || null,
      formaPagoStr: formaPagoFinalStr,
      productosSummary: datosFacturaPendiente.productosSummary,
      usuario: usuarioActivo,
      esFiscal: esFiscalActivo,
      esContribuyenteEspecial: datosFacturaPendiente.esContribuyenteEspecial,
      comprobanteRetencion: datosFacturaPendiente.comprobanteRetencion,
      montoRetencionBS: datosFacturaPendiente.montoRetencionBS,
      montoRetencionUSD: datosFacturaPendiente.montoRetencionUSD,
      montoIGTF_BS: datosFacturaPendiente.montoIGTF_BS,
      montoIGTF_USD: datosFacturaPendiente.montoIGTF_USD,
      totalNetoCobradoBS: datosFacturaPendiente.totalNetoCobradoBS,
      totalNetoCobradoUSD: datosFacturaPendiente.totalNetoCobradoUSD
    });

    // 4. Encolar para sincronización con Supabase
    await dbPut("syncQueue", {
      id: "sync_fac_" + Date.now(),
      payload: {
        action: "guardarFacturaFinal",
        datosFactura: {
          numFactura: String(numFactura),
          fechaStr: datosFacturaPendiente.fechaStr,
          cedula: datosFacturaPendiente.cliente.cedula,
          nombre: datosFacturaPendiente.cliente.nombre,
          telefono: datosFacturaPendiente.cliente.telefono || 'N/D',
          direccion: datosFacturaPendiente.cliente.direccion || null,
          productosSummary: datosFacturaPendiente.productosSummary,
          formaPago: formaPagoFinalStr,
          montoTotal: datosFacturaPendiente.totalUSD,
          desglosePagos: datosFacturaPendiente.desglosePagos,
          usuario: usuarioActivo,
          tablaVentas: datosFacturaPendiente.tablaVentas,
          esFiscal: esFiscalActivo,
          esContribuyenteEspecial: datosFacturaPendiente.esContribuyenteEspecial,
          comprobanteRetencion: datosFacturaPendiente.comprobanteRetencion,
          montoRetencionBS: datosFacturaPendiente.montoRetencionBS,
          montoRetencionUSD: datosFacturaPendiente.montoRetencionUSD,
          montoIGTF_BS: datosFacturaPendiente.montoIGTF_BS,
          montoIGTF_USD: datosFacturaPendiente.montoIGTF_USD,
          totalNetoCobradoBS: datosFacturaPendiente.totalNetoCobradoBS,
          totalNetoCobradoUSD: datosFacturaPendiente.totalNetoCobradoUSD
        }
      }
    });

    if (btn) { btn.disabled = false; btn.textContent = "🖨️ Confirmar y Emitir"; }

    const fueFiscal = Boolean(datosFacturaPendiente?.modoFiscal);
    const tipoDocStr = fueFiscal ? "Factura Fiscal" : "Venta";

    itemsFactura = {};
    transaccionActiva = null;
    clienteFacturaActual = null;
    datosFacturaPendiente = null;
    renderizarResumenFactura();

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalVistaPreviaFactura')).hide();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();

    mostrarAvisoFactura(`🎉 ${tipoDocStr} N° ${numFactura} emitida exitosamente.`);
    procesarColaSincronizacion();

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "🖨️ Confirmar y Emitir"; }
    console.error("Error al emitir factura:", err);
    mostrarAvisoFactura("Error durante la emisión: " + err.message);
  }
}

function retrocederProcesoFactura() {
  if (transaccionActiva && transaccionActiva.items) {
    itemsFactura = { ...transaccionActiva.items };
    transaccionActiva = null;
    renderizarResumenFactura();
  }
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();
}

function cancelarProcesoFactura() {
  if (confirm("¿Está seguro de cancelar el proceso? Se limpiará toda la selección actual.")) {
    itemsFactura = {};
    transaccionActiva = null;
    clienteFacturaActual = null;
    renderizarResumenFactura();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();
    mostrarAvisoFactura("Proceso cancelado. Selección reiniciada.");
  }
}

// LECTOR DE BALANZA PS-30
function abrirModalCodigos() {
  itemsEscaneadosTemporales = [];
  const input = document.getElementById('inputScannerQR');
  if (input) input.value = "";
  
  renderizarTablaEscaneados();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalLectorCodigos')).show();

  setTimeout(() => {
    if (input) input.focus();
  }, 400);
}

function procesarEntradaScanner(cadenaTexto) {
  if (!cadenaTexto.trim()) {
    itemsEscaneadosTemporales = [];
    renderizarTablaEscaneados();
    return;
  }

  const usarPrecioTicket = document.getElementById('chkUsarPrecioTicket') 
    ? document.getElementById('chkUsarPrecioTicket').checked 
    : false;

  const listaCodigos = cadenaTexto.split(/[\n,;\s]+/).map(c => c.trim()).filter(c => c.length >= 12);
  itemsEscaneadosTemporales = [];

  listaCodigos.forEach(codigoCompleto => {
    const numStr = codigoCompleto.replace(/\D/g, '');
    if (numStr.length < 12) return;

    const codProducto = numStr.substring(2, 6);
    const valPesoStr = numStr.substring(6, 11);
    const valPrecioStr = numStr.length >= 18 ? numStr.substring(11) : "";
    const numCodInt = parseInt(codProducto, 10);

    let productoEncontrado = buscarProductoPorCodigo(codProducto, numCodInt);

    if (productoEncontrado) {
      let pesoTotalGramos = parseInt(valPesoStr, 10) || 0;
      let cantidadUds = 1;
      let calcSubtotal = 0;
      let calcPrecioBase = productoEncontrado.precio;
      let cantTxt = "";

      if (productoEncontrado.unidad === 'gramos' || productoEncontrado.unidad === 'mixto') {
        let kg = Math.floor(pesoTotalGramos / 1000);
        let g = pesoTotalGramos % 1000;
        cantTxt = kg > 0 ? (g > 0 ? `${kg} Kg ${g} g` : `${kg} Kg`) : `${g} g`;
        cantidadUds = 1;

        if (usarPrecioTicket && valPrecioStr.length >= 3) {
          let parteEntera = parseInt(valPrecioStr.substring(0, valPrecioStr.length - 2), 10) || 0;
          let parteDecimal = valPrecioStr.substring(valPrecioStr.length - 2);
          calcSubtotal = parseFloat(`${parteEntera}.${parteDecimal}`) || 0;

          if (pesoTotalGramos > 0) {
            calcPrecioBase = calcSubtotal / (pesoTotalGramos / 1000);
          }
        } else {
          calcPrecioBase = productoEncontrado.precio;
          calcSubtotal = (calcPrecioBase / 1000) * pesoTotalGramos;
        }

      } else {
        cantidadUds = 1;
        cantTxt = `1 uds`;

        if (usarPrecioTicket && valPrecioStr.length >= 3) {
          let parteEntera = parseInt(valPrecioStr.substring(0, valPrecioStr.length - 2), 10) || 0;
          let parteDecimal = valPrecioStr.substring(valPrecioStr.length - 2);
          calcSubtotal = parseFloat(`${parteEntera}.${parteDecimal}`) || 0;
          calcPrecioBase = calcSubtotal / cantidadUds;
        } else {
          calcPrecioBase = productoEncontrado.precio;
          calcSubtotal = calcPrecioBase * cantidadUds;
        }
      }

      itemsEscaneadosTemporales.push({
        codigoLeido: codProducto,
        nombre: productoEncontrado.nombre,
        precioBase: calcPrecioBase,
        unidad: productoEncontrado.unidad,
        cantidadTxt: cantTxt,
        cantNumerica: cantidadUds,
        pesoTotalGramos: pesoTotalGramos,
        precioTotal: calcSubtotal.toFixed(2),
        tasaIVA: productoEncontrado.tasaIVA || "E",
        imgPath: productoEncontrado.imgPath,
        encontrado: true
      });

    } else {
      itemsEscaneadosTemporales.push({
        codigoLeido: codProducto,
        nombre: `PRODUCTO NO ENCONTRADO (CÓD: ${codProducto})`,
        precioBase: 0,
        unidad: "N/A",
        cantidadTxt: "N/A",
        cantNumerica: 0,
        pesoTotalGramos: 0,
        precioTotal: "0.00",
        tasaIVA: "E",
        imgPath: "../img/LOGO-MUNDO123.webp",
        encontrado: false
      });
    }
  });

  renderizarTablaEscaneados();
}

function buscarProductoPorCodigo(codStr, numInt) {
  if (!cacheCategoriasFactura || !cacheCategoriasFactura.length) return null;

  const codLimpio = String(codStr || "").trim();
  const codNum = parseInt(codLimpio, 10);

  for (let cat of cacheCategoriasFactura) {
    for (let p of cat.productos) {
      let codAsignado = p[7] ? String(p[7]).trim() : "";
      
      if (codAsignado !== "") {
        let codAsignadoNum = parseInt(codAsignado, 10);
        if (codAsignado === codLimpio || (!isNaN(codAsignadoNum) && codAsignadoNum === codNum)) {
          return {
            nombre: p[0],
            precio: p[1],
            imgPath: p[2].startsWith('../') ? p[2] : '../' + p[2],
            unidad: p[5],
            tasaIVA: p[8] || "E"
          };
        }
      }
    }
  }

  return null;
}

function renderizarTablaEscaneados() {
  const tbody = document.getElementById('tablaItemsEscaneados');
  const btn = document.getElementById('btnAgregarEscaneadosFactura');
  if (!tbody) return;

  if (itemsEscaneadosTemporales.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">Esperando lectura del escáner...</td></tr>`;
    if (btn) btn.disabled = true;
    return;
  }

  let html = "";
  let hayValidos = false;

  itemsEscaneadosTemporales.forEach((it) => {
    if (it.encontrado) hayValidos = true;
    let badgeState = it.encontrado 
      ? `<span class="badge bg-success">✔ Encontrado</span>` 
      : `<span class="badge bg-danger">✕ No Registrado</span>`;

    let precUnitTxt = (it.unidad === 'gramos' || it.unidad === 'mixto') ? `$${it.precioBase.toFixed(2)}/Kg` : `$${it.precioBase.toFixed(2)}/Ud`;

    html += `
      <tr>
        <td class="fw-bold text-center num-legible">${it.codigoLeido}</td>
        <td class="fw-bold ${it.encontrado ? 'text-dark' : 'text-danger'}">${it.nombre}</td>
        <td class="text-center num-legible">${precUnitTxt}</td>
        <td class="text-center fw-bold text-primary num-legible">${it.cantidadTxt}</td>
        <td class="text-end fw-bold text-success num-legible">$${it.precioTotal}</td>
        <td class="text-center">${badgeState}</td>
      </tr>`;
  });

  tbody.innerHTML = html;
  if (btn) btn.disabled = !hayValidos;
}

function confirmarAgregarCodigosAFactura() {
  let agregados = 0;
  const modalProcesarEl = document.getElementById('modalProcesarFactura');
  const estaEnProceso = modalProcesarEl && modalProcesarEl.classList.contains('show');

  let destinoItems = estaEnProceso 
    ? (transaccionActiva ? transaccionActiva.items : itemsFactura)
    : itemsFactura;

  itemsEscaneadosTemporales.forEach(it => {
    if (it.encontrado) {
      destinoItems[it.nombre] = {
        cantidadTxt: it.cantidadTxt,
        cantNumerica: it.cantNumerica,
        pesoTotalGramos: it.pesoTotalGramos,
        precioTotal: it.precioTotal,
        precioBase: it.precioBase,
        unidad: it.unidad,
        minBase: 1,
        pesoPromedio: 0,
        tasaIVA: it.tasaIVA || "E",
        imgPath: it.imgPath
      };
      agregados++;
    }
  });

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalLectorCodigos')).hide();

  if (estaEnProceso) {
    renderizarTablaModalFactura();
    actualizarCalculosBCV();
  } else {
    renderizarResumenFactura();
  }

  mostrarAvisoFactura(`🎉 Se agregaron ${agregados} producto(s) desde el ticket de balanza.`);
}

// ==========================================================================
// MÓDULO DE CONFIGURACIÓN DE DATOS DE LA EMPRESA Y LOGOS
// ==========================================================================

// Abrir cuadro para ingresar el número de registro fiscal privado según la impresora elegida
function solicitarConfiguracionDispositivoFiscal(codigoModelo, nombreModelo) {
  document.getElementById('regFiscalModeloCode').value = codigoModelo;
  document.getElementById('regFiscalModeloNombre').textContent = nombreModelo;
  
  const serialActual = localStorage.getItem(`pos_serial_fiscal_${codigoModelo}`) || "";
  document.getElementById('regFiscalSerialInput').value = serialActual;
  document.getElementById('errorModalRegFiscal').classList.add('hidden');

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalRegistroDispositivoFiscal')).show();
}
window.solicitarConfiguracionDispositivoFiscal = solicitarConfiguracionDispositivoFiscal;

// Procesar confirmación con el formato exacto requerido
async function procesarConfirmacionDispositivoFiscal() {
  const codigo = document.getElementById('regFiscalModeloCode').value;
  const nombre = document.getElementById('regFiscalModeloNombre').textContent;
  const serial = document.getElementById('regFiscalSerialInput').value.trim().toUpperCase();
  const errorDiv = document.getElementById('errorModalRegFiscal');

  if (!serial) {
    if (errorDiv) {
      errorDiv.textContent = "Por favor, ingrese el número de registro o serial fiscal.";
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalRegistroDispositivoFiscal')).hide();

  // Mensaje de confirmación exacto
  const mensajeConfirmacion = `¿Está seguro de que desea conectar la impresora ${nombre} con el número de registro ${serial}?`;
  
  if (confirm(mensajeConfirmacion)) {
    localStorage.setItem(`pos_serial_fiscal_${codigo}`, serial);
    localStorage.setItem("pos_serial_fiscal_activo", serial);
    localStorage.setItem("pos_modelo_impresora_fiscal", codigo);

    await cambiarModeloImpresoraFiscal(codigo);

    mostrarAvisoFactura(`🖨️ ${nombre} configurada con N° de Registro: ${serial} ✅`);

    // Conectar si no estaba conectada
    if (window.fiscalDriver && !window.fiscalDriver.conectado) {
      conectarImpresoraFiscalManual();
    }
  }
}
window.procesarConfirmacionDispositivoFiscal = procesarConfirmacionDispositivoFiscal;

function abrirModalDatosEmpresa() {
  const emp = obtenerDatosEmpresa();
  document.getElementById('cfgEmpresaNombre').value = emp.nombre;
  document.getElementById('cfgEmpresaRIF').value = emp.rif;
  document.getElementById('cfgEmpresaDireccion1').value = emp.direccion1;
  document.getElementById('cfgEmpresaDireccion2').value = emp.direccion2;
  document.getElementById('cfgEmpresaDireccion3').value = emp.direccion3;
  document.getElementById('cfgEmpresaTelefono').value = emp.telefono;

  const t = Date.now();
  document.getElementById('previewLogoFondoBlanco').src = `../img/LOGO-MUNDO123.webp?t=${t}`;
  document.getElementById('previewLogoFondoNegro').src = `../img/LOGOTIPO MUNDOCARNES.jpg?t=${t}`;
  document.getElementById('previewLogoTransparente').src = `../img/MUNDOCARNE TRANSPARENTE.png?t=${t}`;
  document.getElementById('previewLogoSecundarioWeb').src = `../img/MUNDOCARNE-web.webp?t=${t}`;

  document.getElementById('fileLogoFondoBlanco').value = "";
  document.getElementById('fileLogoFondoNegro').value = "";
  document.getElementById('fileLogoTransparente').value = "";
  document.getElementById('fileLogoSecundarioWeb').value = "";

  document.getElementById('errorModalDatosEmpresa').classList.add('hidden');
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalDatosEmpresa')).show();
}
window.abrirModalDatosEmpresa = abrirModalDatosEmpresa;

function previsualizarLogoConfig(inputElem, imgId) {
  if (inputElem.files && inputElem.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const img = document.getElementById(imgId);
      if (img) img.src = e.target.result;
    };
    reader.readAsDataURL(inputElem.files[0]);
  }
}
window.previsualizarLogoConfig = previsualizarLogoConfig;

async function guardarDatosEmpresaYLogos() {
  const nombre = document.getElementById('cfgEmpresaNombre').value.trim().toUpperCase();
  const rif = document.getElementById('cfgEmpresaRIF').value.trim().toUpperCase();
  const dir1 = document.getElementById('cfgEmpresaDireccion1').value.trim().toUpperCase();
  const dir2 = document.getElementById('cfgEmpresaDireccion2').value.trim().toUpperCase();
  const dir3 = document.getElementById('cfgEmpresaDireccion3').value.trim().toUpperCase();
  const tel = document.getElementById('cfgEmpresaTelefono').value.trim();
  const errorDiv = document.getElementById('errorModalDatosEmpresa');

  if (!nombre || !rif || !dir1) {
    if (errorDiv) {
      errorDiv.textContent = "El Nombre, RIF y Dirección principal son obligatorios.";
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  const datosEmpresa = {
    nombre: nombre,
    rif: rif,
    direccion1: dir1,
    direccion2: dir2,
    direccion3: dir3,
    telefono: tel
  };

  localStorage.setItem("pos_empresa_config", JSON.stringify(datosEmpresa));
  await dbPut("config", { key: "empresaConfig", value: datosEmpresa });

  const fBlanco = document.getElementById('fileLogoFondoBlanco');
  const fNegro = document.getElementById('fileLogoFondoNegro');
  const fTransp = document.getElementById('fileLogoTransparente');
  const fWeb = document.getElementById('fileLogoSecundarioWeb');

  const hayLogosParaSubir = (fBlanco.files.length > 0 || fNegro.files.length > 0 || fTransp.files.length > 0 || fWeb.files.length > 0);

  if (hayLogosParaSubir) {
    const token = sessionStorage.getItem("github_token");
    if (!token) {
      accionPendienteGitHub = "guardarDatosEmpresa";
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEscanearTokenGitHub')).show();
      return;
    }

    const btn = document.getElementById('btnGuardarDatosEmpresa');
    if (btn) { btn.disabled = true; btn.textContent = "Subiendo logos a GitHub..."; }

    try {
      if (fBlanco.files.length > 0) {
        const fileData = await validarYLeerArchivoWebPFac(fBlanco);
        if (fileData) await subirArchivoAGitHubFactura("img/LOGO-MUNDO123.webp", fileData.base64, "Actualización Logo Primario Blanco");
      }
      if (fNegro.files.length > 0) {
        const file = fNegro.files[0];
        const base64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.target.result.split(',')[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        await subirArchivoAGitHubFactura("img/LOGOTIPO MUNDOCARNES.jpg", base64, "Actualización Logo Fondo Negro");
      }
      if (fTransp.files.length > 0) {
        const file = fTransp.files[0];
        const base64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.target.result.split(',')[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });
        await subirArchivoAGitHubFactura("img/MUNDOCARNE TRANSPARENTE.png", base64, "Actualización Logo Transparente");
      }
      if (fWeb.files.length > 0) {
        const fileData = await validarYLeerArchivoWebPFac(fWeb);
        if (fileData) await subirArchivoAGitHubFactura("img/MUNDOCARNE-web.webp", fileData.base64, "Actualización Logo Secundario Web");
      }

      if (btn) { btn.disabled = false; btn.textContent = "💾 Guardar Datos y Sincronizar Logos"; }
    } catch (eLogo) {
      if (btn) { btn.disabled = false; btn.textContent = "💾 Guardar Datos y Sincronizar Logos"; }
      console.warn("Aviso al subir logos:", eLogo);
      mostrarAvisoFactura("Datos guardados. Aviso en logos: " + eLogo.message);
      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalDatosEmpresa')).hide();
      return;
    }
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalDatosEmpresa')).hide();
  mostrarAvisoFactura("🎉 Datos de la empresa y recursos actualizados exitosamente.");
}
window.guardarDatosEmpresaYLogos = guardarDatosEmpresaYLogos;

// CONFIGURACIÓN FULLSCREEN DE PRODUCTOS Y PLU
function abrirModalGestionCodigos() {
  document.getElementById('facFiltroCodigosInput').value = "";
  prepararListaProductosCodigos();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalGestionCodigos')).show();
}

function prepararListaProductosCodigos() {
  listaFlatProductosCodigos = [];

  cacheCategoriasFactura.forEach(cat => {
    cat.productos.forEach((p, idx) => {
      let nom = p[0];
      let prec = p[1];
      let imgPath = p[2].startsWith('../') ? p[2] : '../' + p[2];
      let esDisp = p[3] !== undefined ? p[3] : true;
      let minVal = p[4] !== undefined ? p[4] : 1;
      let unidad = p[5] || "unidades";
      let pesoProm = p[6] || 0;
      let codPLU = p[7] ? String(p[7]).trim() : "";
      let tasaIVA = p[8] || "E";

      listaFlatProductosCodigos.push({
        nombreOriginal: nom,
        categoriaOriginal: cat.nombre,
        nombre: nom,
        precio: prec,
        categoria: cat.nombre,
        imgPath: imgPath,
        disponible: esDisp,
        minimo: minVal,
        unidad: unidad,
        pesoPromedio: pesoProm,
        codigoPLU: codPLU,
        tasaIVA: tasaIVA,
        orden: idx + 1
      });
    });
  });

  listaFlatProductosCodigos.sort((a, b) => {
    let numA = a.codigoPLU !== "" ? parseInt(a.codigoPLU, 10) : 999999;
    let numB = b.codigoPLU !== "" ? parseInt(b.codigoPLU, 10) : 999999;

    if (isNaN(numA)) numA = 999999;
    if (isNaN(numB)) numB = 999999;

    if (numA !== numB) {
      return numA - numB;
    }
    return a.nombre.localeCompare(b.nombre);
  });

  renderizarTablaGestionCodigos(listaFlatProductosCodigos);
}

function renderizarTablaGestionCodigos(lista) {
  const tbody = document.getElementById('tablaGestionCodigos');
  const badgeCount = document.getElementById('cntTotalProductosCodigos');
  if (!tbody) return;

  if (badgeCount) badgeCount.textContent = `Total: ${lista.length} Productos`;

  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="text-center text-muted py-4">No hay productos registrados.</td></tr>`;
    return;
  }

  let html = "";
  lista.forEach((item, index) => {
    let safeName = item.nombreOriginal.replace(/["']/g, '');
    let safeCat = item.categoriaOriginal.replace(/["']/g, '');
    let catSelectHtml = cacheCategoriasFactura.map(c => `
      <option value="${c.nombre}" ${c.nombre === item.categoriaOriginal ? 'selected' : ''}>${c.nombre}</option>
    `).join('');

    let disabledPeso = (item.unidad !== 'mixto') ? 'disabled' : '';

    html += `
      <tr class="fila-producto-cfg" data-index="${index}" data-original-name="${safeName}" data-original-cat="${safeCat}">
        <td class="text-center">
          <input type="text" class="form-control form-control-sm text-center fw-bold text-primary cfg-plu num-legible" 
                 value="${item.codigoPLU}" placeholder="PLU">
        </td>
        <td class="text-center position-relative">
          <label class="mb-0" title="Haga clic para cambiar imagen (.webp <120KB)">
            <img src="${item.imgPath}" class="img-thumb-config-inline" id="thumb-cfg-${index}">
            <input type="file" class="d-none cfg-file" accept="image/webp" onchange="previsualizarFotoInline(this, ${index})">
          </label>
        </td>
        <td>
          <input type="text" class="form-control form-control-sm fw-bold cfg-nombre" value="${item.nombre}" placeholder="Nombre producto">
        </td>
        <td>
          <select class="form-select form-select-sm fw-semibold cfg-cat">
            ${catSelectHtml}
          </select>
        </td>
        <td>
          <select class="form-select form-select-sm fw-semibold cfg-unidad" onchange="alternarCampoPesoFila(this)">
            <option value="unidades" ${item.unidad === 'unidades' ? 'selected' : ''}>Unidades</option>
            <option value="gramos" ${item.unidad === 'gramos' ? 'selected' : ''}>Gramos</option>
            <option value="mixto" ${item.unidad === 'mixto' ? 'selected' : ''}>Mixto</option>
          </select>
        </td>
        <td>
          <input type="number" class="form-control form-control-sm text-center cfg-pesoprom num-legible" 
                 value="${item.pesoPromedio || ''}" placeholder="g" min="1" ${disabledPeso}>
        </td>
        <td>
          <input type="number" class="form-control form-control-sm text-center cfg-orden num-legible" 
                 value="${item.orden}" min="1" style="max-width: 55px; margin: 0 auto;">
        </td>
        <td>
          <input type="number" class="form-control form-control-sm text-center cfg-minimo num-legible" 
                 value="${item.minimo}" min="1" style="max-width: 65px; margin: 0 auto;">
        </td>
        <td>
          <select class="form-select form-select-sm fw-bold cfg-disp">
            <option value="true" ${item.disponible ? 'selected' : ''}>✅ Disp.</option>
            <option value="false" ${!item.disponible ? 'selected' : ''}>🚫 Agot.</option>
          </select>
        </td>
        <td>
          <select class="form-select form-select-sm fw-bold text-center cfg-iva">
            <option value="E" ${item.tasaIVA === 'E' ? 'selected' : ''}>E (0%)</option>
            <option value="G" ${item.tasaIVA === 'G' ? 'selected' : ''}>G (16%)</option>
            <option value="R" ${item.tasaIVA === 'R' ? 'selected' : ''}>R (8%)</option>
          </select>
        </td>
        <td>
          <input type="number" step="0.01" min="0.01" class="form-control form-control-sm text-center fw-bold text-success cfg-precio num-legible" 
                 value="${parseFloat(item.precio).toFixed(2)}" style="max-width: 85px; margin: 0 auto;">
        </td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 border-0 fw-bold" onclick="eliminarProductoFilaInline('${safeName}', '${safeCat}')" title="Eliminar Producto">
            🗑️
          </button>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

function filtrarTablaCodigos(query) {
  if (!query.trim()) {
    renderizarTablaGestionCodigos(listaFlatProductosCodigos);
    return;
  }

  const q = query.trim().toLowerCase();
  const filtrados = listaFlatProductosCodigos.filter(item => {
    return item.nombre.toLowerCase().includes(q) || 
           item.categoria.toLowerCase().includes(q) || 
           item.codigoPLU.toLowerCase().includes(q);
  });

  renderizarTablaGestionCodigos(filtrados);
}

function alternarCampoPesoFila(selectElem) {
  const fila = selectElem.closest('tr');
  if (!fila) return;
  const inputPeso = fila.querySelector('.cfg-pesoprom');
  if (inputPeso) {
    inputPeso.disabled = (selectElem.value !== 'mixto');
    if (selectElem.value === 'mixto' && !inputPeso.value) {
      inputPeso.value = "2000";
    }
  }
}
window.alternarCampoPesoFila = alternarCampoPesoFila;

function previsualizarFotoInline(fileInput, idx) {
  if (fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    if (file.size > 120 * 1024) {
      alert("⚠️ La imagen excede el límite de 120 KB.");
      fileInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
      const imgElem = document.getElementById(`thumb-cfg-${idx}`);
      if (imgElem) imgElem.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }
}
window.previsualizarFotoInline = previsualizarFotoInline;

function alternarCampoPesoPromedioPOS(val, modo) {
  const cont = document.getElementById('contenedorPosAddPesoPromedio');
  if (cont) {
    if (val === 'mixto') cont.classList.remove('hidden');
    else cont.classList.add('hidden');
  }
}
window.alternarCampoPesoPromedioPOS = alternarCampoPesoPromedioPOS;

function validarYLeerArchivoWebPFac(fileElement) {
  return new Promise((resolve, reject) => {
    const file = fileElement.files[0];
    if (!file) {
      resolve(null);
      return;
    }

    const esWebP = file.type === "image/webp" || file.name.toLowerCase().endsWith(".webp");
    if (!esWebP) {
      reject("La imagen debe estar en formato .webp obligatoriamente.");
      return;
    }

    const limitePeso = 120 * 1024;
    if (file.size > limitePeso) {
      reject("La imagen debe pesar menos de 120 KB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
      const base64 = e.target.result.split(",")[1];
      const safeName = file.name.replace(/\s+/g, "_").toLowerCase();
      resolve({ base64: base64, name: safeName });
    };
    reader.onerror = function() {
      reject("Error al leer el archivo físico de imagen.");
    };
    reader.readAsDataURL(file);
  });
}

function guardarTodosLosCodigosPLU() {
  const token = sessionStorage.getItem("github_token");
  if (!token) {
    accionPendienteGitHub = "guardarCodigosMasivo";
    const input = document.getElementById('inputTokenQR');
    if (input) input.value = "";
    document.getElementById('errorModalTokenQR').classList.add('hidden');
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEscanearTokenGitHub')).show();
    setTimeout(() => { if (input) input.focus(); }, 400);
    return;
  }

  procesarSincronizacionGitHub();
}

async function procesarSincronizacionGitHub() {
  const btn = document.getElementById('btnGuardarCodigosPLU');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sincronizando con GitHub...";
  }

  try {
    // 1. Actualizar en memoria los productos que estén actualmente renderizados en la tabla
    const filas = document.querySelectorAll('.fila-producto-cfg');
    filas.forEach(f => {
      const origName = f.getAttribute('data-original-name');
      const origCat = f.getAttribute('data-original-cat');

      const itemEnLista = listaFlatProductosCodigos.find(p => p.nombreOriginal === origName && p.categoriaOriginal === origCat);
      if (itemEnLista) {
        itemEnLista.codigoPLU = f.querySelector('.cfg-plu').value.trim();
        itemEnLista.nombre = f.querySelector('.cfg-nombre').value.trim() || itemEnLista.nombre;
        itemEnLista.categoria = f.querySelector('.cfg-cat').value;
        itemEnLista.unidad = f.querySelector('.cfg-unidad').value;
        itemEnLista.pesoPromedio = (itemEnLista.unidad === 'mixto') ? (parseInt(f.querySelector('.cfg-pesoprom').value) || 2000) : 0;
        itemEnLista.orden = parseInt(f.querySelector('.cfg-orden').value) || itemEnLista.orden;
        itemEnLista.minimo = parseInt(f.querySelector('.cfg-minimo').value) || itemEnLista.minimo;
        itemEnLista.disponible = (f.querySelector('.cfg-disp').value === "true");
        itemEnLista.tasaIVA = f.querySelector('.cfg-iva') ? f.querySelector('.cfg-iva').value : "E";
        itemEnLista.precio = parseFloat(f.querySelector('.cfg-precio').value) || itemEnLista.precio;
      }
    });

    // 2. Subir imágenes nuevas si fueron seleccionadas
    for (let f of filas) {
      const origName = f.getAttribute('data-original-name');
      const origCat = f.getAttribute('data-original-cat');
      const fileInput = f.querySelector('.cfg-file');
      const itemEnLista = listaFlatProductosCodigos.find(p => p.nombreOriginal === origName && p.categoriaOriginal === origCat);

      if (fileInput && fileInput.files && fileInput.files.length > 0 && itemEnLista) {
        const imgData = await validarYLeerArchivoWebPFac(fileInput);
        if (imgData) {
          const filePath = `img/${imgData.name}`;
          await subirArchivoAGitHubFactura(filePath, imgData.base64, `Subida de imagen: ${imgData.name}`);
          itemEnLista.imgPath = filePath;
        }
      }
    }

    // 3. Reconstruir las 5 categorías completas desde el arreglo maestro para garantizar que ninguna categoría se pierda
    let categoriasMap = {};
    cacheCategoriasFactura.forEach(c => {
      categoriasMap[c.nombre] = [];
    });

    listaFlatProductosCodigos.forEach(item => {
      let catDestino = item.categoria || item.categoriaOriginal;
      if (!categoriasMap[catDestino]) categoriasMap[catDestino] = [];

      let cleanImg = (item.imgPath || "img/LOGO-MUNDO123.webp").replace(/^\.\.\//, '');

      categoriasMap[catDestino].push({
        datos: [
          item.nombre,
          item.precio,
          cleanImg,
          item.disponible,
          item.minimo,
          item.unidad,
          item.pesoPromedio,
          item.codigoPLU,
          item.tasaIVA
        ],
        orden: item.orden
      });
    });

    // Ordenar y consolidar las categorías completas
    cacheCategoriasFactura.forEach(cat => {
      let prodsEnCat = categoriasMap[cat.nombre] || [];
      prodsEnCat.sort((a, b) => a.orden - b.orden);
      cat.productos = prodsEnCat.map(p => p.datos);
    });

    // 4. Guardar catálogo íntegro en GitHub
    const contentString = JSON.stringify({ categorias: cacheCategoriasFactura }, null, 2);
    const base64Content = btoa(unescape(encodeURIComponent(contentString)));

    await subirArchivoAGitHubFactura("catalog.json", base64Content, "Actualización completa y protegida de catálogo desde POS");

    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Guardar Todos los Cambios";
    }

    renderizarCatalogoFacturacion({ categorias: cacheCategoriasFactura });
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalGestionCodigos')).hide();
    mostrarAvisoFactura("🎉 Catálogo completo de 118 productos sincronizado con éxito.");

  } catch (err) {
    sessionStorage.removeItem("github_token");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Guardar Todos los Cambios";
    }
    console.error("Error al guardar en GitHub:", err);
    mostrarAvisoFactura("❌ Error de sincronización con GitHub: " + err.message);
  }
}

async function eliminarProductoFilaInline(nom, cat) {
  if (!confirm(`⚠️ ¿Está seguro que desea eliminar el producto "${nom}"?`)) return;

  const token = sessionStorage.getItem("github_token");
  if (!token) {
    accionPendienteGitHub = "guardarCodigosMasivo";
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEscanearTokenGitHub')).show();
    return;
  }

  try {
    let catObj = cacheCategoriasFactura.find(c => c.nombre === cat);
    if (catObj) {
      catObj.productos = catObj.productos.filter(p => p[0] !== nom);
    }

    const contentString = JSON.stringify({ categorias: cacheCategoriasFactura }, null, 2);
    const base64Content = btoa(unescape(encodeURIComponent(contentString)));

    await subirArchivoAGitHubFactura("catalog.json", base64Content, `Eliminación de producto: ${nom}`);

    renderizarCatalogoFacturacion({ categorias: cacheCategoriasFactura });
    prepararListaProductosCodigos();
    mostrarAvisoFactura(`🗑️ Producto "${nom}" eliminado correctamente.`);

  } catch (err) {
    alert("Error al eliminar: " + err.message);
  }
}
window.eliminarProductoFilaInline = eliminarProductoFilaInline;

function abrirModalCrearProductoPOS() {
  const catSelect = document.getElementById('posAddProdCatSelect');
  catSelect.innerHTML = cacheCategoriasFactura.map(c => `<option value="${c.nombre}">${c.nombre}</option>`).join('');

  document.getElementById('posAddProdNombre').value = "";
  document.getElementById('posAddProdPrecio').value = "";
  if (document.getElementById('posAddProdIVA')) {
    document.getElementById('posAddProdIVA').value = "E";
  }
  document.getElementById('posAddProdCodigo').value = "";
  document.getElementById('posAddProdUnidad').value = "gramos";
  document.getElementById('posAddProdPesoPromedio').value = "";
  document.getElementById('posAddProdMinimo').value = "250";
  document.getElementById('posAddProdArchivoImagen').value = "";
  document.getElementById('contenedorPosAddPesoPromedio').classList.add('hidden');
  document.getElementById('errorModalCrearProdPOS').classList.add('hidden');

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCrearProductoPOS')).show();
}

async function ejecutarCrearNuevoProductoPOS() {
  const errorDiv = document.getElementById('errorModalCrearProdPOS');
  const catNombre = document.getElementById('posAddProdCatSelect').value;
  const prodNombre = document.getElementById('posAddProdNombre').value.trim().toUpperCase();
  const prodPrecio = parseFloat(document.getElementById('posAddProdPrecio').value);
  const prodIVA = document.getElementById('posAddProdIVA') ? document.getElementById('posAddProdIVA').value : "E";
  const prodCodigo = document.getElementById('posAddProdCodigo').value.trim();
  const prodUnidad = document.getElementById('posAddProdUnidad').value;
  const prodPesoProm = (prodUnidad === "mixto") ? parseInt(document.getElementById('posAddProdPesoPromedio').value) : 0;
  const prodMin = parseInt(document.getElementById('posAddProdMinimo').value) || 1;
  const fileInput = document.getElementById('posAddProdArchivoImagen');

  if (!catNombre || !prodNombre || isNaN(prodPrecio) || prodPrecio <= 0 || !fileInput.files.length) {
    errorDiv.textContent = "Por favor, complete todos los campos obligatorios e incluya la imagen WebP.";
    errorDiv.classList.remove('hidden');
    return;
  }

  const token = sessionStorage.getItem("github_token");
  if (!token) {
    accionPendienteGitHub = "crearNuevoProducto";
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEscanearTokenGitHub')).show();
    return;
  }

  const btn = document.getElementById('btnCrearProdPOS');
  btn.disabled = true;
  btn.textContent = "Creando...";

  try {
    const imgData = await validarYLeerArchivoWebPFac(fileInput);
    if (!imgData) throw new Error("Debe seleccionar una imagen en formato .webp menor a 120 KB.");

    const relativePath = `img/${imgData.name}`;
    await subirArchivoAGitHubFactura(relativePath, imgData.base64, `Creación producto POS con imagen: ${imgData.name}`);

    let cat = cacheCategoriasFactura.find(c => c.nombre === catNombre);
    if (cat) {
      cat.productos.push([prodNombre, prodPrecio, relativePath, true, prodMin, prodUnidad, prodPesoProm, prodCodigo, prodIVA]);
    }

    const contentString = JSON.stringify({ categorias: cacheCategoriasFactura }, null, 2);
    const base64Content = btoa(unescape(encodeURIComponent(contentString)));

    await subirArchivoAGitHubFactura("catalog.json", base64Content, `Nuevo producto anexado desde POS: ${prodNombre}`);

    btn.disabled = false;
    btn.textContent = "➕ Crear y Guardar Producto";

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCrearProductoPOS')).hide();
    renderizarCatalogoFacturacion({ categorias: cacheCategoriasFactura });
    prepararListaProductosCodigos();

    mostrarAvisoFactura(`🎉 Producto "${prodNombre}" creado y publicado con éxito.`);

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "➕ Crear y Guardar Producto";
    errorDiv.textContent = "Error: " + err.message;
    errorDiv.classList.remove('hidden');
  }
}

async function ejecutarGuardadoConTokenQR() {
  const input = document.getElementById('inputTokenQR');
  const errorDiv = document.getElementById('errorModalTokenQR');
  const token = input ? input.value.trim() : "";

  if (!token) {
    if (errorDiv) {
      errorDiv.textContent = "Por favor, escanee el código QR de autorización de seguridad.";
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  sessionStorage.setItem("github_token", token);
  input.value = "";

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEscanearTokenGitHub')).hide();

  if (accionPendienteGitHub === "crearNuevoProducto") {
    ejecutarCrearNuevoProductoPOS();
  } else if (accionPendienteGitHub === "guardarDatosEmpresa") {
    guardarDatosEmpresaYLogos();
  } else {
    procesarSincronizacionGitHub();
  }

  accionPendienteGitHub = null;
}

// ==========================================================================
// CONVERSOR GLOBAL DE FECHAS A TIMESTAMP (DISPONIBLE PARA TODO EL SISTEMA)
// ==========================================================================
function parsearFechaTimestamp(fStr) {
  if (!fStr) return 0;
  try {
    let t = Date.parse(fStr);
    if (!isNaN(t)) return t;

    // Procesar formato latino: DD/MM/YYYY, HH:mm:ss (a.m. / p.m.)
    const partes = String(fStr).trim().split(/[,\s]+/);
    if (partes.length >= 1) {
      const fechaPartes = partes[0].split(/[\/\-]/);
      if (fechaPartes.length === 3) {
        let dia = parseInt(fechaPartes[0], 10);
        let mes = parseInt(fechaPartes[1], 10) - 1;
        let anio = parseInt(fechaPartes[2], 10);
        if (anio < 100) anio += 2000;

        let horas = 0, minutos = 0, segundos = 0;
        if (partes.length >= 2) {
          const horaPartes = partes[1].split(':');
          horas = parseInt(horaPartes[0], 10) || 0;
          minutos = parseInt(horaPartes[1], 10) || 0;
          segundos = parseInt(horaPartes[2], 10) || 0;

          const esPM = /p\.?\s*m\.?/i.test(fStr);
          const esAM = /a\.?\s*m\.?/i.test(fStr);
          if (esPM && horas < 12) horas += 12;
          if (esAM && horas === 12) horas = 0;
        }

        const d = new Date(anio, mes, dia, horas, minutos, segundos);
        if (!isNaN(d.getTime())) return d.getTime();
      }
    }
  } catch (e) {}
  return 0;
}

// HISTORIAL Y BÚSQUEDA DE FACTURAS (CON IDENTIFICADOR FISCAL)
function abrirModalBuscarFacturas() {
  document.getElementById('facBusquedaInput').value = "";
  if (document.getElementById('facLimiteSelect')) {
    document.getElementById('facLimiteSelect').value = "10";
  }
  buscarFacturasHistorial('ultimas');
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalBuscarFacturas')).show();
}

async function buscarFacturasHistorial(modo) {
  const inputElem = document.getElementById('facBusquedaInput');
  const inputVal = inputElem ? inputElem.value.trim().toUpperCase() : "";
  const usuarioActivo = obtenerUsuarioActivo();
  const tablaUsuarioActivo = obtenerTablaVentasUsuario(usuarioActivo);
  
  if (modo === 'busqueda' && !inputVal) {
    return mostrarAvisoFactura("Ingrese Cédula, RIF o N° de Factura a buscar.");
  }

  let mapFacturas = {};

 try {
    let ventasLocales = await dbGetAll("ventas");
    if (Array.isArray(ventasLocales)) {
      ventasLocales.forEach(f => {
        if (f && f.numFactura) {
          const userFila = normalizarUsuario(f.usuario || usuarioActivo);
          if (userFila === usuarioActivo || userFila === "admin") {
            mapFacturas[String(f.numFactura)] = {
              numFactura: String(f.numFactura),
              fechaStr: f.fechaStr || "",
              cedula: f.cedula || "V-00000000",
              nombre: f.nombre || "CONSUMIDOR FINAL",
              direccion: f.direccion || null,
              productosSummary: f.productosSummary || "",
              formaPagoStr: f.formaPagoStr || "EFECTIVO",
              montoTotalUSD: parseFloat(f.montoTotalUSD) || 0,
              usuario: f.usuario || usuarioActivo,
              esFiscal: Boolean(f.esFiscal || String(f.formaPagoStr || "").includes("FISCAL")),
              montoIGTF_BS: parseFloat(f.montoIGTF_BS || f.MONTO_IGTF_BS) || 0,
              montoIGTF_USD: parseFloat(f.montoIGTF_USD || f.MONTO_IGTF_USD) || 0,
              totalNetoCobradoBS: parseFloat(f.totalNetoCobradoBS || f.TOTAL_NETO_COBRADO_BS) || 0,
              totalNetoCobradoUSD: parseFloat(f.totalNetoCobradoUSD || f.TOTAL_NETO_COBRADO_USD) || 0,
              comprobanteRetencion: f.comprobanteRetencion || f.COMPROBANTE_RETENCION || null,
              montoRetencionBS: parseFloat(f.montoRetencionBS || f.MONTO_RETENCION_BS) || 0,
              montoRetencionUSD: parseFloat(f.montoRetencionUSD || f.MONTO_RETENCION_USD) || 0
            };
          }
        }
      });
    }
  } catch (errDb) {
    console.warn("Aviso al consultar ventas locales en IndexedDB:", errDb);
  }

  if (navigator.onLine) {
    try {
      const ventasSup = await obtenerTodasLasVentasSupabase(tablaUsuarioActivo);
      if (Array.isArray(ventasSup) && ventasSup.length > 0) {
        ventasSup.forEach(v => {
          let numFac = v.FACTURA || v["FACTURA N°"] || v.numFactura;
          if (numFac) {
            mapFacturas[String(numFac)] = {
              numFactura: String(numFac),
              fechaStr: v["FECHA"] || v.fechaStr || "",
              cedula: v["CEDULA O RIF"] || v.cedula || "V-00000000",
              nombre: v["NOMBRE / RAZON SOCIAL"] || v.nombre || "CONSUMIDOR FINAL",
              direccion: v["UBICACION"] || v.direccion || null,
              productosSummary: v["PRODUCTOS"] || v.productosSummary || "",
              formaPagoStr: v["FORMA DE PAGO"] || v.formaPagoStr || "",
              montoTotalUSD: parseFloat(v["MONTO TOTAL"] || v.montoTotalUSD) || 0,
              usuario: usuarioActivo,
              esFiscal: Boolean(String(v["FORMA DE PAGO"] || "").includes("FISCAL") || v.esFiscal),
              montoIGTF_BS: parseFloat(v["MONTO_IGTF_BS"] || v.montoIGTF_BS || v["IGTF"]) || 0,
              montoIGTF_USD: parseFloat(v["MONTO_IGTF_USD"] || v.montoIGTF_USD) || 0,
              totalNetoCobradoBS: parseFloat(v["TOTAL_NETO_COBRADO_BS"] || v.totalNetoCobradoBS) || 0,
              totalNetoCobradoUSD: parseFloat(v["TOTAL_NETO_COBRADO_USD"] || v.totalNetoCobradoUSD) || 0,
              comprobanteRetencion: v["COMPROBANTE_RETENCION"] || v.comprobanteRetencion || null,
              montoRetencionBS: parseFloat(v["MONTO_RETENCION_BS"] || v.montoRetencionBS) || 0,
              montoRetencionUSD: parseFloat(v["MONTO_RETENCION_USD"] || v.montoRetencionUSD) || 0
            };
          }
        });
      }
    } catch (err) {
      console.warn("Aviso al consultar Supabase en historial:", err);
    }
  }

  let todasLasFacturas = Object.values(mapFacturas).sort((a, b) => {
    // 1. Orden principal por fecha y hora más reciente
    const timeA = parsearFechaTimestamp(a.fechaStr);
    const timeB = parsearFechaTimestamp(b.fechaStr);
    if (timeB !== timeA) {
      return timeB - timeA;
    }
    // 2. Desempate por correlativo
    let numA = parseInt(String(a.numFactura || "").replace(/\D/g, ''), 10) || 0;
    let numB = parseInt(String(b.numFactura || "").replace(/\D/g, ''), 10) || 0;
    return numB - numA;
  });

  const limiteSeleccionado = document.getElementById('facLimiteSelect') 
    ? parseInt(document.getElementById('facLimiteSelect').value, 10) 
    : 10;

  if (modo === 'ultimas') {
    cacheHistorialFacturas = todasLasFacturas.slice(0, limiteSeleccionado);
  } else if (inputVal) {
    cacheHistorialFacturas = todasLasFacturas.filter(f => {
      return (f.numFactura && String(f.numFactura).toUpperCase().includes(inputVal)) ||
             (f.cedula && String(f.cedula).toUpperCase().includes(inputVal)) ||
             (f.nombre && String(f.nombre).toUpperCase().includes(inputVal));
    }).slice(0, 200);
  } else {
    cacheHistorialFacturas = todasLasFacturas.slice(0, limiteSeleccionado);
  }

  for (let f of cacheHistorialFacturas) {
    await dbPut("ventas", f);
  }

  renderizarTablaHistorialFacturas();
}

function renderizarTablaHistorialFacturas() {
  const tbody = document.getElementById('tablaHistorialFacturas');
  if (!tbody) return;

  if (cacheHistorialFacturas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">No se encontraron facturas registradas para este usuario.</td></tr>`;
    return;
  }

  let html = "";
  cacheHistorialFacturas.forEach(f => {
    const numFacStr = String(f.numFactura || "");
    const formaStr = String(f.formaPagoStr || "");
    const esRealmenteFiscal = Boolean(
      f.esFiscal === true || 
      f.esFiscal === "true" || 
      formaStr.toUpperCase().includes("FISCAL") || 
      numFacStr.startsWith("FAC-") || 
      /^\d{8}$/.test(numFacStr)
    );

    let badgeTipo = esRealmenteFiscal 
      ? `<span class="badge bg-primary fw-bold px-2 py-1">🏷️ Fiscal</span>` 
      : `<span class="badge bg-secondary px-2 py-1">📄 No Fiscal</span>`;

    // Botón de Nota de Crédito: ACTIVO ÚNICA Y EXCLUSIVAMENTE PARA VENTAS FISCALES
    let botonNotaCredito = esRealmenteFiscal
      ? `<button type="button" class="btn btn-sm btn-warning text-dark py-0 px-2 fw-bold rounded-pill shadow-sm" onclick="abrirModalNotaCreditoFiscal('${f.numFactura}')" title="Emitir Nota de Crédito Fiscal en HKA80">↩️ NC</button>`
      : "";

    html += `
      <tr>
        <td class="fw-bold text-center text-danger num-legible text-nowrap">${f.numFactura}</td>
        <td class="text-center text-nowrap">${badgeTipo}</td>
        <td class="text-center small num-legible text-nowrap">${f.fechaStr}</td>
        <td class="fw-bold text-center num-legible text-nowrap">${f.cedula}</td>
        <td class="fw-bold text-truncate" style="max-width: 140px;" title="${f.nombre}">${f.nombre}</td>
        <td class="small text-muted text-truncate" style="max-width: 170px;" title="${formaStr}">${formaStr}</td>
        <td class="text-end fw-bold text-success num-legible text-nowrap">$${parseFloat(f.montoTotalUSD).toFixed(2)}</td>
        <td class="text-center text-nowrap">
          <div class="acciones-historial-group">
            ${botonNotaCredito}
            <button type="button" class="btn btn-sm btn-primary py-0 px-2 fw-bold rounded-pill" onclick="reimprimirFacturaHistorial('${f.numFactura}')" title="Reimprimir Ticket">
              🖨️ Imprimir
            </button>
            <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fw-bold rounded-pill" onclick="eliminarFacturaHistorial('${f.numFactura}')" title="Eliminar Registro">
              🗑️
            </button>
          </div>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

function reimprimirFacturaHistorial(numFactura) {
  const fac = cacheHistorialFacturas.find(f => f.numFactura === numFactura);
  if (!fac) return mostrarAvisoFactura("No se localizó la información de la factura.");

  const tasa = obtenerTasaBCV();
  const totalUSD = parseFloat(fac.montoTotalUSD) || 0;
  const totalBs = totalUSD * (tasa > 0 ? tasa : 1);

  datosFacturaPendiente = {
    numFactura: fac.numFactura,
    fechaStr: fac.fechaStr,
    cliente: {
      cedula: fac.cedula,
      nombre: fac.nombre,
      direccion: fac.direccion || 'N/D',
      telefono: 'N/D'
    },
    formaPagoStr: fac.formaPagoStr,
    totalUSD: totalUSD,
    totalBs: totalBs,
    tasaBCV: tasa,
    monedaVistaModal: "USD",
    productosSummary: fac.productosSummary,
    modoFiscal: false
  };

  renderizarTicketTermicoHistorialHTML(datosFacturaPendiente);
  const ticketHtml = document.getElementById('contenidoTicketImprimible').innerHTML;
  ejecutarImpresionTicket(ticketHtml);
  mostrarAvisoFactura(`🖨️ Reimprimiendo Factura N° ${numFactura}...`);
}

function renderizarTicketTermicoHistorialHTML(d) {
  const esFiscal = Boolean(d.modoFiscal || d.esFiscal || String(d.formaPagoStr || "").includes("FISCAL") || /^\d{8}$/.test(String(d.numFactura || "")));
  let ticketHtml = "";

  if (esFiscal) {
    // =========================================================================
    // REIMPRESIÓN HISTORIAL: FORMATO EXACTO PP9 PLUS CON DESGLOSE TRIBUTARIO COMPLETO
    // =========================================================================
    const emp = obtenerDatosEmpresa();
    const serialFiscal = obtenerSerialFiscalActivo();
    const esNC = Boolean(d.esNotaCredito || String(d.numFactura || "").startsWith("NC-") || String(d.formaPagoStr || "").includes("NOTA DE CREDITO"));
    const numDocPP9 = String(d.numFactura || "00000000").replace(/\D/g, '').padStart(8, '0');
    const tasa = d.tasaBCV || 780.00;

    let itemsHtml = "";
    let totExentoBs = 0;
    let totBase16Bs = 0;
    let totIVA16Bs = 0;
    let totGeneralBs = 0;

    if (d.productosSummary) {
      const listaProds = d.productosSummary.split(' | ');
      listaProds.forEach(prodStr => {
        let nom = "";
        let tasaTag = "E";
        let cantTxt = "1 uds";
        let subUSD = 0;

        let partesGuion = prodStr.split(/\s*-\s*\$/);
        if (partesGuion.length === 2) {
          subUSD = parseFloat(partesGuion[1]) || 0;
          let textoIzquierdo = partesGuion[0].trim();

          let matchCant = textoIzquierdo.match(/\(([^()]+)\)$/);
          if (matchCant) {
            cantTxt = matchCant[1].trim();
            textoIzquierdo = textoIzquierdo.substring(0, matchCant.index).trim();
          }

          let matchTasa = textoIzquierdo.match(/\(([EGRegr0-9%]+)\)$/);
          if (matchTasa) {
            let tStr = matchTasa[1].toUpperCase();
            if (tStr.includes('G') || tStr.includes('16')) tasaTag = 'G';
            else if (tStr.includes('R') || tStr.includes('8')) tasaTag = 'R';
            else tasaTag = 'E';
            nom = textoIzquierdo.substring(0, matchTasa.index).trim();
          } else {
            nom = textoIzquierdo;
          }
        } else {
          nom = prodStr.trim();
        }

        let subBs = subUSD * tasa;
        let factorIVA = (tasaTag === "G" || tasaTag === "16") ? 1.16 : 1.0;
        let baseImponibleBs = subBs / factorIVA;
        let ivaBs = subBs - baseImponibleBs;

        if (tasaTag === "G" || tasaTag === "16") {
          totBase16Bs += baseImponibleBs;
          totIVA16Bs += ivaBs;
        } else {
          totExentoBs += subBs;
        }
        totGeneralBs += subBs;

        let esPesa = cantTxt.includes('Kg') || cantTxt.includes('g');
        let cantNum = 1;
        let matchNum = cantTxt.match(/([0-9.]+)\s*uds/i);
        if (matchNum) cantNum = parseFloat(matchNum[1]) || 1;

        if (esPesa) {
          let kgMatch = cantTxt.match(/([0-9.]+)\s*Kg/i);
          let gMatch = cantTxt.match(/([0-9.]+)\s*g/i);
          let kgVal = kgMatch ? parseFloat(kgMatch[1]) : 0;
          let gVal = gMatch ? parseFloat(gMatch[1]) : 0;
          let pesoTotalKg = kgVal + (gVal / 1000);
          if (pesoTotalKg === 0 && gVal > 0) pesoTotalKg = gVal / 1000;
          if (pesoTotalKg === 0) pesoTotalKg = 1;

          let unitarioBs = subBs / pesoTotalKg;
          let kgStr = pesoTotalKg.toFixed(3).replace('.', ',');

          itemsHtml += `
            <div class="pp9-linea-multiplicador">${kgStr}xBs ${unitarioBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <div class="pp9-fila-item">
              <span class="pp9-item-nombre">${nom} (${tasaTag})</span>
              <span class="pp9-item-monto">Bs ${subBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>`;
        } else if (cantNum > 1) {
          let unitarioBs = subBs / cantNum;
          itemsHtml += `
            <div class="pp9-linea-multiplicador">${cantNum}x Bs ${unitarioBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <div class="pp9-fila-item">
              <span class="pp9-item-nombre">${nom} (${tasaTag})</span>
              <span class="pp9-item-monto">Bs ${subBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>`;
        } else {
          itemsHtml += `
            <div class="pp9-fila-item">
              <span class="pp9-item-nombre">${nom} (${tasaTag})</span>
              <span class="pp9-item-monto">Bs ${subBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>`;
        }
      });
    }

    if (totGeneralBs === 0 && d.totalBs) {
      totGeneralBs = Math.abs(d.totalBs);
    }

    // Desglose fiscal exacto antes de totales
    let bloqueDesgloseFiscal = "";
    if (totExentoBs > 0) {
      bloqueDesgloseFiscal += `
        <div class="pp9-fila-item">
          <span>EXENTO</span>
          <span>Bs ${totExentoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>`;
    }
    if (totBase16Bs > 0) {
      bloqueDesgloseFiscal += `
        <div class="pp9-fila-item">
          <span>BI G (16,00%)</span>
          <span>Bs ${totBase16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div class="pp9-fila-item">
          <span>IVA G (16,00%)</span>
          <span>Bs ${totIVA16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>`;
    }

    let cedulaCliente = String(d.cliente?.cedula || d.cedula || "V-00000000").trim();
    if (!/^[VJEGPvjegp]/i.test(cedulaCliente)) cedulaCliente = "V-" + cedulaCliente;

    let bloqueCompRet = (d.comprobanteRetencion || d.COMPROBANTE_RETENCION) 
      ? `<div>COMP RET ${d.comprobanteRetencion || d.COMPROBANTE_RETENCION}</div>` : '';
    let bloqueIGTF = (d.montoIGTF_BS > 0 || d.MONTO_IGTF_BS > 0) 
      ? `<div>IG.. 3 BS ${parseFloat(d.montoIGTF_BS || d.MONTO_IGTF_BS).toFixed(2)}</div>` : '';

    let encabezadoTipoDoc = esNC ? `
      <div class="pp9-info-doc">
        <div>#FAC:${d.facturaAfectada || '00000022'}</div>
        <div>FECHA FAC:${d.fechaFacturaAfectada || '24/08/2026'}</div>
        <div>#CONTROL/SERIAL IF:${serialFiscal}</div>
        <div>RIF/CI:${cedulaCliente}</div>
        <div>R.S.:${String(d.cliente?.nombre || d.nombre || 'CLIENTE').toUpperCase()}</div>
        <div>MOTIVO: DEVOLUCION DE MERCANCIA</div>
      </div>
      <div class="pp9-titulo-doc text-center mt-1">NOTA DE CREDITO</div>
      <div class="pp9-info-doc">
        <div class="pp9-fila-item">
          <span>NOTA DE CREDITO:</span>
          <span class="pp9-bold">${numDocPP9}</span>
        </div>
        <div class="pp9-fila-item">
          <span>FECHA: ${String(d.fechaStr || '').split(',')[0] || '24-08-2026'}</span>
          <span>HORA: ${String(d.fechaStr || '').split(',')[1] || '05:20'}</span>
        </div>
      </div>` : `
      <div class="pp9-cliente-bloque">
        <div>RIF/CI:${cedulaCliente}</div>
        <div>R.S.:${String(d.cliente?.nombre || d.nombre || 'CONSUMIDOR FINAL').toUpperCase()}</div>
        <div>${String(d.cliente?.direccion || d.direccion || 'CARACAS').toUpperCase()}</div>
        <div>${d.cliente?.telefono || 'N/D'}</div>
        ${bloqueCompRet}
        ${bloqueIGTF}
      </div>
      <div class="pp9-titulo-doc text-center">FACTURA</div>
      <div class="pp9-info-doc">
        <div class="pp9-fila-item">
          <span>FACTURA:</span>
          <span class="pp9-bold">${numDocPP9}</span>
        </div>
        <div class="pp9-fila-item">
          <span>FECHA: ${String(d.fechaStr || '').split(',')[0] || '24-08-2026'}</span>
          <span>HORA: ${String(d.fechaStr || '').split(',')[1] || '05:14'}</span>
        </div>
      </div>`;

    ticketHtml = `
      <div class="ticket-pp9-wrapper">
        <div class="pp9-header text-center">
          <div class="pp9-bold">SENIAT</div>
          <div class="pp9-bold">${emp.rif}</div>
          <div class="pp9-bold">${emp.nombre}</div>
          <div>${emp.direccion1}</div>
          <div>${emp.direccion2}</div>
          <div>${emp.direccion3}</div>
        </div>

        ${encabezadoTipoDoc}

        <div class="pp9-separator-dashed"></div>

        <div class="pp9-cuerpo-items">
          ${itemsHtml}
        </div>

        <div class="pp9-separator-dashed"></div>

        <div class="pp9-totales-bloque">
          ${bloqueDesgloseFiscal}
          <div class="pp9-separator-dashed"></div>
          <div class="pp9-fila-item">
            <span>EFECTIVO 1</span>
            <span>Bs ${totGeneralBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div class="pp9-fila-item pp9-bold mt-1">
            <span>TOTAL</span>
            <span>Bs ${totGeneralBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        </div>

        <div class="pp9-footer d-flex justify-content-between mt-2">
          <span>MH</span>
          <span class="pp9-bold">${serialFiscal}</span>
        </div>
      </div>
    `;

  } else {
    // REIMPRESIÓN CONTROL INTERNO NO FISCAL (INTACTO)
    let filasProductosHtml = "";
    let i = 1;

    if (d.productosSummary) {
      const listaProds = d.productosSummary.split(' | ');
      listaProds.forEach(prodStr => {
        const match = prodStr.match(/^(.*?)(?:\s*\((.*?)\))?\s*-\s*\$(.*)$/);
        if (match) {
          let nom = match[1].trim();
          let cant = match[2] ? match[2].trim() : "1 uds";
          let tot = match[3] ? match[3].trim() : "0.00";

          filasProductosHtml += `
            <tr>
              <td style="width:6%;">${i++}</td>
              <td style="width:42%;" class="fw-bold">${nom}</td>
              <td style="width:18%;" class="text-center">--</td>
              <td style="width:16%;" class="text-center">${cant}</td>
              <td style="width:18%;" class="text-end fw-bold">$${tot}</td>
            </tr>`;
        } else {
          filasProductosHtml += `
            <tr>
              <td style="width:6%;">${i++}</td>
              <td colspan="3" class="fw-bold">${prodStr}</td>
              <td style="width:18%;" class="text-end fw-bold">--</td>
            </tr>`;
        }
      });
    }

    ticketHtml = `
      <div class="ticket-container shadow-sm border">
        <div class="ticket-header">
          <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
          <div class="ticket-title fs-6">COMPROBANTE NO FISCAL - NOTA DE ENTREGA</div>
          <div>RIF: J-505072889 | TELF: 0412-1753275</div>
          <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
          <div>HORARIO: 7:30am - 19:00pm</div>
        </div>

        <div class="ticket-info">
          <div><strong>FACTURA N°:</strong> <span class="fs-6 num-legible">${d.numFactura}</span> (COPIA)</div>
          <div><strong>FECHA:</strong> <span class="num-legible">${d.fechaStr}</span></div>
          <div><strong>CLIENTE:</strong> ${d.cliente?.nombre || d.nombre || 'CONSUMIDOR FINAL'}</div>
          <div><strong>CI/RIF:</strong> <span class="num-legible">${d.cliente?.cedula || d.cedula || 'N/D'}</span></div>
          <div><strong>DIR:</strong> ${d.cliente?.direccion || d.direccion || 'N/D'}</div>
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
          <div class="d-flex justify-content-between">
            <span>TOTAL FACTURA ($):</span>
            <strong class="fs-6 num-legible">$${d.totalUSD.toFixed(2)}</strong>
          </div>
          <div class="d-flex justify-content-between text-muted">
            <span>TOTAL FACTURA (Bs):</span>
            <span class="num-legible">Bs. ${d.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          <div class="ticket-divider"></div>
          <div><strong>FORMA DE PAGO:</strong></div>
          <div class="small">${d.formaPagoStr}</div>
        </div>

        <div class="ticket-footer">
          <div>¡Gracias por su preferencia!</div>
        </div>
      </div>
    `;
  }

  const elemImpresion = document.getElementById('contenidoTicketImprimible');
  if (elemImpresion) elemImpresion.innerHTML = ticketHtml;
}

async function eliminarFacturaHistorial(numFactura) {
  if (!confirm(`⚠️ ¿Está seguro que desea eliminar permanentemente la Factura N° ${numFactura}?`)) {
    return;
  }

  const tablaUsuarioActivo = obtenerTablaVentasUsuario();
  await dbDelete("ventas", numFactura);
  await dbDelete("creditos", numFactura);
  cacheHistorialFacturas = cacheHistorialFacturas.filter(f => f.numFactura !== numFactura);
  renderizarTablaHistorialFacturas();

  await dbPut("syncQueue", {
    id: "sync_del_fac_" + Date.now(),
    payload: { action: "eliminarFactura", numFactura: numFactura, tablaVentas: tablaUsuarioActivo }
  });

  mostrarAvisoFactura(`🗑️ Factura ${numFactura} eliminada.`);
  procesarColaSincronizacion();
}

// ==========================================================================
// CENTRO DE DESCARGAS: REPORTE OPERATIVO Y LIBRO DE VENTAS FISCAL SENIAT
// ==========================================================================
function abrirModalSeleccionDescargas() {
  const inputFecha = document.getElementById('descargaFechaInput');
  const selectForma = document.getElementById('descargaFormaPagoSelect');
  const errorDiv = document.getElementById('errorModalDescarga');

  if (inputFecha) {
    const hoy = new Date().toISOString().split('T')[0];
    inputFecha.value = hoy;
  }
  if (selectForma) selectForma.value = "TODOS";
  if (errorDiv) errorDiv.classList.add('hidden');

  // Configurar mes y año fiscal por defecto (Mes actual)
  const fechaHoy = new Date();
  const mesActual = fechaHoy.getMonth() + 1;
  const anioActual = fechaHoy.getFullYear();

  const selMes = document.getElementById('seniatMesSelect');
  const inpAnio = document.getElementById('seniatAnioInput');
  const selPeriodo = document.getElementById('seniatPeriodoSelect');

  if (selMes) selMes.value = String(mesActual);
  if (inpAnio) inpAnio.value = String(anioActual);
  if (selPeriodo) selPeriodo.value = (fechaHoy.getDate() <= 15) ? "Q1" : "Q2";

  actualizarFechasPeriodoSeniat();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFiltroDescarga')).show();
}

function abrirModalFiltroDescarga() {
  abrirModalSeleccionDescargas();
}

function actualizarFechasPeriodoSeniat() {
  const selPeriodo = document.getElementById('seniatPeriodoSelect')?.value || "Q2";
  const mes = parseInt(document.getElementById('seniatMesSelect')?.value || "8", 10);
  const anio = parseInt(document.getElementById('seniatAnioInput')?.value || "2026", 10);
  const contRango = document.getElementById('contenedorRangoFechasSeniat');
  const inpDesde = document.getElementById('seniatFechaDesde');
  const inpHasta = document.getElementById('seniatFechaHasta');

  if (!contRango || !inpDesde || !inpHasta) return;

  const ultimoDiaMes = new Date(anio, mes, 0).getDate();
  const mesStr = String(mes).padStart(2, '0');

  if (selPeriodo === "Q1") {
    contRango.classList.add('hidden');
    inpDesde.value = `${anio}-${mesStr}-01`;
    inpHasta.value = `${anio}-${mesStr}-15`;
  } else if (selPeriodo === "Q2") {
    contRango.classList.add('hidden');
    inpDesde.value = `${anio}-${mesStr}-16`;
    inpHasta.value = `${anio}-${mesStr}-${String(ultimoDiaMes).padStart(2, '0')}`;
  } else if (selPeriodo === "MES") {
    contRango.classList.add('hidden');
    inpDesde.value = `${anio}-${mesStr}-01`;
    inpHasta.value = `${anio}-${mesStr}-${String(ultimoDiaMes).padStart(2, '0')}`;
  } else {
    contRango.classList.remove('hidden');
    if (!inpDesde.value) inpDesde.value = `${anio}-${mesStr}-01`;
    if (!inpHasta.value) inpHasta.value = `${anio}-${mesStr}-${String(ultimoDiaMes).padStart(2, '0')}`;
  }
}

// 1. REPORTE OPERATIVO DE VENTAS EN EXCEL (FUNCIONAMIENTO ACTUAL INTACTO)
async function ejecutarDescargaExcelFacturas() {
  const fechaVal = document.getElementById('descargaFechaInput').value;
  const formaPagoVal = document.getElementById('descargaFormaPagoSelect').value;
  const errorDiv = document.getElementById('errorModalDescarga');
  const btn = document.getElementById('btnProcesarDescargaExcel');
  const tablaUsuarioActivo = obtenerTablaVentasUsuario();

  if (!fechaVal) {
    if (errorDiv) {
      errorDiv.textContent = "Por favor, seleccione la fecha deseada.";
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  if (errorDiv) errorDiv.classList.add('hidden');

  btn.disabled = true;
  btn.textContent = "Generando Excel...";

  try {
    const [ano, mes, dia] = fechaVal.split('-');
    const patronFecha1 = `${dia}/${mes}/${ano}`;
    const patronFecha2 = `${parseInt(dia, 10)}/${parseInt(mes, 10)}/${ano}`;

    const todosRegistros = await obtenerTodasLasVentasSupabase(tablaUsuarioActivo);

    btn.disabled = false;
    btn.textContent = "📊 Descargar Reporte Operativo (.xlsx)";

    if (todosRegistros && todosRegistros.length > 0) {
      const registrosFiltrados = todosRegistros.filter(r => {
        const fStr = String(r["FECHA"] || "");
        const coincideFecha = fStr.includes(patronFecha1) || fStr.includes(patronFecha2) || fStr.startsWith(fechaVal);
        if (!coincideFecha) return false;

        if (formaPagoVal !== "TODOS" && formaPagoVal !== "") {
          const formaStr = String(r["FORMA DE PAGO"] || "").toUpperCase();
          if (formaPagoVal === "Cashea") {
            return formaStr.includes("CASHEA");
          } else if (formaPagoVal === "Crédito") {
            return formaStr.includes("CRÉDITO") || formaStr.includes("CREDITO");
          } else if (formaPagoVal === "Pago Mixto") {
            return formaStr.includes("MIXTO") || formaStr.includes("+");
          } else {
            return formaStr.includes(formaPagoVal.toUpperCase());
          }
        }
        return true;
      });

      if (registrosFiltrados.length === 0) {
        if (errorDiv) {
          errorDiv.textContent = "No se encontraron ventas registradas para la fecha y método seleccionados.";
          errorDiv.classList.remove('hidden');
        }
        return;
      }

      const filasExcel = registrosFiltrados.map(r => ({
        "Fecha / Hora": r["FECHA"] || "",
        "Factura N°": r.FACTURA || r["FACTURA N°"] || "",
        "Cédula / RIF": r["CEDULA O RIF"] || "",
        "Cliente": r["NOMBRE / RAZON SOCIAL"] || "",
        "Dirección / Ubicación": r["UBICACION"] || "",
        "Productos": r["PRODUCTOS"] || "",
        "Forma de Pago": r["FORMA DE PAGO"] || "",
        "Monto Total ($)": parseFloat(r["MONTO TOTAL"]) || 0,
        "Efectivo Divisas ($)": parseFloat(r["EFECTIVO DIVISAS"]) || 0,
        "Efectivo Bolívares (Bs)": parseFloat(r["EFECTIVO BOLIVARES"]) || 0,
        "Pago Móvil (Bs)": parseFloat(r["PAGO MOVIL"]) || 0,
        "Zelle ($)": parseFloat(r["ZELLE"]) || 0,
        "PayPal ($)": parseFloat(r["PAYPAL"]) || 0,
        "Cashea ($)": parseFloat(r["CASHEA"]) || 0,
        "Crédito ($)": parseFloat(r["CREDITO"]) || 0,
        "Punto de Venta (Bs)": parseFloat(r["PUNTO DE VENTA"]) || 0,
        "Transferencia (Bs)": parseFloat(r["TRANSFERENCIA"] || r["TRANSFERECIA"]) || 0,
        "Biopago (Bs)": parseFloat(r["BIOPAGO"]) || 0
      }));

      const worksheet = XLSX.utils.json_to_sheet(filasExcel);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Facturas");

      const maxCols = Object.keys(filasExcel[0]).map(key => ({
        wch: Math.max(key.length, ...filasExcel.map(r => String(r[key] || "").length)) + 2
      }));
      worksheet['!cols'] = maxCols;

      const nombreArchivo = `Reporte_Operativo_${tablaUsuarioActivo}_${fechaVal}_${formaPagoVal.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
      XLSX.writeFile(workbook, nombreArchivo);

      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFiltroDescarga')).hide();
      mostrarAvisoFactura("🎉 Reporte operativo generado y descargado exitosamente.");

    } else {
      if (errorDiv) {
        errorDiv.textContent = `No se encontraron registros en ${tablaUsuarioActivo} para la fecha seleccionada.`;
        errorDiv.classList.remove('hidden');
      }
    }

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "📊 Descargar Reporte Operativo (.xlsx)";
    console.error("Error al descargar reporte Excel:", err);
    if (errorDiv) {
      errorDiv.textContent = "Error de conexión al obtener el reporte Excel.";
      errorDiv.classList.remove('hidden');
    }
  }
}

// ==========================================================================
// MÓDULO EXCLUSIVO: NOTAS DE CRÉDITO FISCALES (SENIAT)
// ==========================================================================
let datosNCPendiente = null;
let itemsDevueltosNC = {};

function abrirModalNotaCreditoFiscal(numFactura) {
  const fac = cacheHistorialFacturas.find(f => String(f.numFactura) === String(numFactura));
  if (!fac) return mostrarAvisoFactura("No se localizó la información de la factura fiscal.");

  const tasa = obtenerTasaBCV();
  const factorTasa = tasa > 0 ? tasa : 1;

  // Detección inteligente de IGTF y Total Neto real de la factura original
  const montoTotalBaseUSD = parseFloat(fac.montoTotalUSD) || 0;
  const formaUpper = String(fac.formaPagoStr || "").toUpperCase();
  const esPagoDivisas = formaUpper.includes("DIVISAS") || formaUpper.includes("ZELLE") || formaUpper.includes("PAYPAL") || formaUpper.includes("EFECTIVO DIVISAS");

  let montoIGTF_USD = parseFloat(fac.montoIGTF_USD || fac["MONTO_IGTF_USD"]) || 0;
  let montoIGTF_BS = parseFloat(fac.montoIGTF_BS || fac["MONTO_IGTF_BS"]) || 0;

  // Si no estaba en el registro pero fue pagada en divisas con IGTF, calcular el 3%
  if (montoIGTF_USD === 0 && esPagoDivisas && montoTotalBaseUSD > 0) {
    montoIGTF_USD = parseFloat((montoTotalBaseUSD * 0.03).toFixed(2));
    montoIGTF_BS = parseFloat((montoIGTF_USD * factorTasa).toFixed(2));
  }

  const totalNetoOriginalUSD = parseFloat(fac.totalNetoCobradoUSD || fac["TOTAL_NETO_COBRADO_USD"] || (montoTotalBaseUSD + montoIGTF_USD)) || (montoTotalBaseUSD + montoIGTF_USD);

  datosNCPendiente = {
    facturaAfectada: fac.numFactura,
    fechaFacturaAfectada: fac.fechaStr,
    cliente: {
      cedula: fac.cedula || "V-00000000",
      nombre: fac.nombre || "CONSUMIDOR FINAL"
    },
    totalOriginalUSD: totalNetoOriginalUSD,
    montoTotalBaseUSD: montoTotalBaseUSD,
    montoIGTF_BS: montoIGTF_BS,
    montoIGTF_USD: montoIGTF_USD,
    tasaBCV: factorTasa,
    serialImpresora: window.fiscalDriver?.ultimoReporteStatus?.serial || obtenerSerialFiscalActivo(),
    itemsOriginales: {}
  };

  const elemFacAf = document.getElementById('ncFacturaAfectada');
  const elemFecAf = document.getElementById('ncFechaAfectada');
  const elemCed = document.getElementById('ncCedulaCliente');
  const elemNom = document.getElementById('ncNombreCliente');
  const elemTot = document.getElementById('ncTotalOriginalUSD');
  const elemTipo = document.getElementById('ncTipoOperacionSelect');
  const elemMot = document.getElementById('ncMotivoSelect');
  const errDiv = document.getElementById('errorModalNC');

  if (elemFacAf) elemFacAf.value = fac.numFactura;
  if (elemFecAf) elemFecAf.value = fac.fechaStr;
  if (elemCed) elemCed.value = fac.cedula;
  if (elemNom) elemNom.value = fac.nombre;
  if (elemTot) elemTot.value = `$${totalNetoOriginalUSD.toFixed(2)}`;
  if (elemTipo) elemTipo.value = "TOTAL";
  if (elemMot) elemMot.value = "DEVOLUCION DE MERCANCIA";
  if (errDiv) errDiv.classList.add('hidden');

  const prodsStr = String(fac.productosSummary || "");
  itemsDevueltosNC = {};

  if (prodsStr) {
    const listaItems = prodsStr.split(' | ');
    listaItems.forEach((pStr, idx) => {
      const match = pStr.match(/^(.*?)(?:\s*\((.*?)\))?\s*-\s*\$(.*)$/);
      let nombre = match ? match[1].trim() : `ITEM ${idx + 1}`;
      let cantTxt = match && match[2] ? match[2].trim() : "1 uds";
      let subUSD = match && match[3] ? parseFloat(match[3]) : (montoTotalBaseUSD / listaItems.length);

      let tasaItem = "E";
      if (pStr.toUpperCase().includes('(G)') || pStr.toUpperCase().includes('(16%)')) tasaItem = "G";
      else if (pStr.toUpperCase().includes('(R)') || pStr.toUpperCase().includes('(8%)')) tasaItem = "R";
      else {
        for (let cat of cacheCategoriasFactura) {
          let pCat = cat.productos.find(p => p[0] === nombre);
          if (pCat) { tasaItem = (pCat[8] || "E").toUpperCase(); break; }
        }
      }

      let cantNumerica = 1;
      let unidad = "unidades";
      if (cantTxt.includes('Kg') || cantTxt.includes('g')) {
        unidad = "gramos";
        cantNumerica = 1000;
      }

      itemsDevueltosNC[nombre] = {
        nombre: nombre,
        cantidadTxt: cantTxt,
        cantNumerica: cantNumerica,
        unidad: unidad,
        precioBase: subUSD,
        precioTotal: subUSD.toFixed(2),
        tasaIVA: tasaItem,
        incluido: true
      };
    });
  } else {
    itemsDevueltosNC["PRODUCTOS FACTURA FISCAL"] = {
      nombre: "PRODUCTOS FACTURA FISCAL",
      cantidadTxt: "1 uds",
      cantNumerica: 1,
      unidad: "unidades",
      precioBase: montoTotalBaseUSD,
      precioTotal: montoTotalBaseUSD.toFixed(2),
      tasaIVA: "E",
      incluido: true
    };
  }

  datosNCPendiente.itemsOriginales = { ...itemsDevueltosNC };
  renderizarTablaItemsNC(true);
  recalcularTotalesNC();

  const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "Impresora Fiscal";
  const btnEmitirNC = document.getElementById('btnConfirmarEmisionNC');
  if (btnEmitirNC) {
    btnEmitirNC.textContent = `🧾 Emitir Nota de Crédito Fiscal en ${nombreModelo}`;
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalNotaCreditoFiscal')).show();
}

function alternarTipoOperacionNC(tipo) {
  const esTotal = (tipo === "TOTAL");
  for (let key in itemsDevueltosNC) {
    itemsDevueltosNC[key].incluido = esTotal ? true : itemsDevueltosNC[key].incluido;
  }
  renderizarTablaItemsNC(esTotal);
  recalcularTotalesNC();
}

function renderizarTablaItemsNC(bloquearChecks = true) {
  const tbody = document.getElementById('tablaItemsNotaCredito');
  if (!tbody) return;

  let html = "";
  for (let key in itemsDevueltosNC) {
    const it = itemsDevueltosNC[key];
    const checkedAttr = it.incluido ? "checked" : "";
    const disabledAttr = bloquearChecks ? "disabled" : "";
    const tasaBadge = (it.tasaIVA === "G" || it.tasaIVA === "16") 
      ? `<span class="badge bg-danger">G (16%)</span>` 
      : `<span class="badge bg-secondary">E (0%)</span>`;

    html += `
      <tr>
        <td class="text-center">
          <input class="form-check-input check-item-nc" type="checkbox" ${checkedAttr} ${disabledAttr} onchange="alternarCheckItemNC('${key}', this.checked)">
        </td>
        <td class="fw-bold">${it.nombre}</td>
        <td class="text-center">${tasaBadge}</td>
        <td class="text-center num-legible">$${parseFloat(it.precioBase).toFixed(2)}</td>
        <td class="text-center small num-legible">${it.cantidadTxt}</td>
        <td class="text-end fw-bold text-danger num-legible">$${it.precioTotal}</td>
      </tr>`;
  }

  tbody.innerHTML = html || `<tr><td colspan="6" class="text-center text-muted py-3">No hay renglones.</td></tr>`;
}

function alternarCheckItemNC(key, marcado) {
  if (itemsDevueltosNC[key]) {
    itemsDevueltosNC[key].incluido = marcado;
    recalcularTotalesNC();
  }
}

function recalcularTotalesNC() {
  const tasa = datosNCPendiente?.tasaBCV || obtenerTasaBCV() || 1;
  let totalUSD = 0;
  let exentoUSD = 0;
  let base16USD = 0;
  let iva16USD = 0;

  for (let key in itemsDevueltosNC) {
    const it = itemsDevueltosNC[key];
    if (it.incluido) {
      const sub = parseFloat(it.precioTotal) || 0;
      totalUSD += sub;

      if (it.tasaIVA === "G" || it.tasaIVA === "16") {
        let base = sub / 1.16;
        let iva = sub - base;
        base16USD += base;
        iva16USD += iva;
      } else {
        exentoUSD += sub;
      }
    }
  }

  // Calcular IGTF a reversar si la factura original devengó IGTF (3%)
  let igtfReversarUSD = 0;
  let igtfReversarBS = 0;

  if (datosNCPendiente && (datosNCPendiente.montoIGTF_USD > 0 || datosNCPendiente.montoIGTF_BS > 0)) {
    igtfReversarUSD = parseFloat((totalUSD * 0.03).toFixed(2));
    igtfReversarBS = parseFloat((igtfReversarUSD * tasa).toFixed(2));
  }

  const totalConIGTF_USD = parseFloat((totalUSD + igtfReversarUSD).toFixed(2));
  const totalConIGTF_BS = parseFloat(((totalUSD * tasa) + igtfReversarBS).toFixed(2));
  const exentoBS = exentoUSD * tasa;
  const base16BS = base16USD * tasa;
  const iva16BS = iva16USD * tasa;

  document.getElementById('ncMontoTotalUSD').textContent = `-$${totalConIGTF_USD.toFixed(2)}`;
  document.getElementById('ncMontoTotalBS').textContent = `-Bs. ${totalConIGTF_BS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;  document.getElementById('ncExentoBS').textContent = `Bs. ${exentoBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('ncBase16BS').textContent = `Bs. ${base16BS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('ncIVA16BS').textContent = `Bs. ${iva16BS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (datosNCPendiente) {
    datosNCPendiente.totalReversarUSD = totalConIGTF_USD;
    datosNCPendiente.totalReversarBS = totalConIGTF_BS;
    datosNCPendiente.montoIGTF_Reversar_USD = igtfReversarUSD;
    datosNCPendiente.montoIGTF_Reversar_BS = igtfReversarBS;
    datosNCPendiente.exentoBS = exentoBS;
    datosNCPendiente.base16BS = base16BS;
    datosNCPendiente.iva16BS = iva16BS;
  }
}

async function confirmarEmisionNotaCreditoFiscal() {
  if (!datosNCPendiente) return;

  const errorDiv = document.getElementById('errorModalNC');
  const btn = document.getElementById('btnConfirmarEmisionNC');
  const motivo = document.getElementById('ncMotivoSelect').value;
  const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "Impresora Fiscal";

  let itemsFinalesNC = {};
  for (let key in itemsDevueltosNC) {
    if (itemsDevueltosNC[key].incluido) {
      itemsFinalesNC[key] = itemsDevueltosNC[key];
    }
  }

  if (Object.keys(itemsFinalesNC).length === 0 || datosNCPendiente.totalReversarUSD <= 0) {
    if (errorDiv) {
      errorDiv.textContent = "Debe seleccionar al menos un producto a reversar.";
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  if (errorDiv) errorDiv.classList.add('hidden');

  btn.disabled = true;
  btn.textContent = `Transmitiendo Nota de Crédito a ${nombreModelo}...`;

  try {
    if (!window.fiscalDriver || !window.fiscalDriver.conectado) {
      const conectar = confirm("La impresora fiscal no está conectada. ¿Desea conectarla ahora para emitir la Nota de Crédito?");
      if (conectar) {
        await window.fiscalDriver.solicitarYConectar();
      } else {
        btn.disabled = false;
        btn.textContent = `🧾 Emitir Nota de Crédito Fiscal en ${nombreModelo}`;
        return;
      }
    }

    const datosPayloadNC = {
      cliente: datosNCPendiente.cliente,
      facturaAfectada: datosNCPendiente.facturaAfectada,
      fechaFacturaAfectada: datosNCPendiente.fechaFacturaAfectada,
      serialImpresoraAfectada: datosNCPendiente.serialImpresora,
      itemsDevueltos: itemsFinalesNC,
      motivo: motivo,
      tasaBCV: datosNCPendiente.tasaBCV,
      montoIGTF_BS: datosNCPendiente.montoIGTF_Reversar_BS || 0,
      montoIGTF_USD: datosNCPendiente.montoIGTF_Reversar_USD || 0
    };

    const resNC = await window.fiscalDriver.emitirNotaCreditoFiscal(datosPayloadNC);
    const numNCGenerado = resNC.numNotaCredito || `NC-${Date.now().toString().slice(-6)}`;
    const usuarioActivo = obtenerUsuarioActivo();
    const tablaUsuarioActivo = obtenerTablaVentasUsuario();

    const registroNCLocal = {
      numFactura: String(numNCGenerado),
      facturaAfectada: datosNCPendiente.facturaAfectada,
      fechaStr: new Date().toLocaleString('es-VE'),
      montoTotalUSD: -Math.abs(datosNCPendiente.totalReversarUSD),
      cedula: datosNCPendiente.cliente.cedula,
      nombre: datosNCPendiente.cliente.nombre,
      direccion: null,
      formaPagoStr: `NOTA DE CREDITO (AFECTA FACT ${datosNCPendiente.facturaAfectada})`,
      productosSummary: `NOTA DE CREDITO POR: ${motivo}`,
      usuario: usuarioActivo,
      esFiscal: true,
      esNotaCredito: true,
      montoIGTF_BS: -Math.abs(datosNCPendiente.montoIGTF_Reversar_BS || 0),
      montoIGTF_USD: -Math.abs(datosNCPendiente.montoIGTF_Reversar_USD || 0)
    };

    await dbPut("ventas", registroNCLocal);

    await dbPut("syncQueue", {
      id: "sync_nc_" + Date.now(),
      payload: {
        action: "guardarFacturaFinal",
        datosFactura: {
          numFactura: String(numNCGenerado),
          facturaAfectada: String(datosNCPendiente.facturaAfectada),
          fechaStr: registroNCLocal.fechaStr,
          cedula: registroNCLocal.cedula,
          nombre: registroNCLocal.nombre,
          telefono: 'N/D',
          direccion: `NC AFECTA FACTURA: ${datosNCPendiente.facturaAfectada}`,
          productosSummary: registroNCLocal.productosSummary,
          formaPago: registroNCLocal.formaPagoStr,
          montoTotal: -Math.abs(datosNCPendiente.totalReversarUSD),
          desglosePagos: {},
          usuario: usuarioActivo,
          tablaVentas: tablaUsuarioActivo,
          esFiscal: true,
          esNotaCredito: true,
          montoIGTF_BS: -Math.abs(datosNCPendiente.montoIGTF_Reversar_BS || 0),
          montoIGTF_USD: -Math.abs(datosNCPendiente.montoIGTF_Reversar_USD || 0)
        }
      }
    });

    btn.disabled = false;
    btn.textContent = `🧾 Emitir Nota de Crédito Fiscal en ${nombreModelo}`;

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalNotaCreditoFiscal')).hide();
    mostrarAvisoFactura(`🎉 Nota de Crédito Fiscal N° ${numNCGenerado} emitida exitosamente en la máquina fiscal.`);

    buscarFacturasHistorial('ultimas');
    procesarColaSincronizacion();

  } catch (errNC) {
    btn.disabled = false;
    btn.textContent = `🧾 Emitir Nota de Crédito Fiscal en ${nombreModelo}`;
    console.error("Error al emitir NC:", errNC);
    if (errorDiv) {
      errorDiv.textContent = "Error durante la emisión de la Nota de Crédito: " + errNC.message;
      errorDiv.classList.remove('hidden');
    }
  }
}

window.abrirModalNotaCreditoFiscal = abrirModalNotaCreditoFiscal;
window.alternarTipoOperacionNC = alternarTipoOperacionNC;
window.alternarCheckItemNC = alternarCheckItemNC;
window.confirmarEmisionNotaCreditoFiscal = confirmarEmisionNotaCreditoFiscal;

// 2. GENERADOR Y EXPORTADOR OFICIAL DEL LIBRO DE VENTAS FISCAL SENIAT (.xlsx y .pdf) CON HOJA DE REPORTES Z
async function ejecutarDescargaLibroSeniat(formato = 'excel') {
  const errorDiv = document.getElementById('errorModalDescarga');
  const fechaDesdeStr = document.getElementById('seniatFechaDesde')?.value;
  const fechaHastaStr = document.getElementById('seniatFechaHasta')?.value;
  const mesNombre = document.getElementById('seniatMesSelect')?.selectedOptions[0]?.text || "Mes";
  const anioFiscal = document.getElementById('seniatAnioInput')?.value || "2026";
  const periodoTexto = document.getElementById('seniatPeriodoSelect')?.selectedOptions[0]?.text || "Período";

  if (!fechaDesdeStr || !fechaHastaStr) {
    if (errorDiv) {
      errorDiv.textContent = "Indique el rango de fechas para el Libro de Ventas Fiscal.";
      errorDiv.classList.remove('hidden');
    }
    return;
  }

  if (errorDiv) errorDiv.classList.add('hidden');
  mostrarAvisoFactura(`🔄 Generando Libro de Ventas SENIAT (${formato.toUpperCase()})...`);

  try {
    const dDesde = new Date(`${fechaDesdeStr}T00:00:00`);
    const dHasta = new Date(`${fechaHastaStr}T23:59:59`);
    const tasaActual = obtenerTasaBCV() || 778.00;
    const serialFiscalPredeterminado = obtenerSerialFiscalActivo();

    // 1. OBTENER VENTAS FISCALES
    let todasLasVentas = [];
    if (navigator.onLine) {
      todasLasVentas = await obtenerTodasLasVentasSupabase('ventas');
    } else {
      todasLasVentas = await dbGetAll("ventas");
    }

    // 2. OBTENER CIERRES / REPORTES Z
    let todosLosCierres = [];
    if (navigator.onLine) {
      try {
        const { data: cierresSup } = await supabaseClient.from('cierres').select('*');
        if (cierresSup) todosLosCierres = cierresSup;
      } catch (e) {}
    }
    if (!todosLosCierres || todosLosCierres.length === 0) {
      todosLosCierres = await dbGetAll("cierres");
    }

    // Filtrar facturas fiscales del período
    const ventasPeriodo = (todasLasVentas || []).filter(v => {
      const formaStr = String(v["FORMA DE PAGO"] || v.formaPagoStr || "").toUpperCase();
      const numFac = String(v.FACTURA || v["FACTURA N°"] || v.numFactura || "");
      
      const esRealmenteFiscal = Boolean(
        v.esFiscal === true ||
        v.esFiscal === "true" ||
        formaStr.includes("FISCAL") ||
        formaStr.includes("NOTA DE CREDITO") ||
        numFac.startsWith("FAC-") || 
        numFac.startsWith("NC-") ||
        /^\d{8}$/.test(numFac)
      );

      if (!esRealmenteFiscal) return false;

      const fStr = String(v["FECHA"] || v.fechaStr || "");
      const ts = parsearFechaTimestamp(fStr);
      if (ts > 0) {
        const dVenta = new Date(ts);
        return dVenta >= dDesde && dVenta <= dHasta;
      }
      return false;
    }).sort((a, b) => {
      return parsearFechaTimestamp(a["FECHA"] || a.fechaStr) - parsearFechaTimestamp(b["FECHA"] || b.fechaStr);
    });

    // Filtrar EXCLUSIVAMENTE reportes Z FISCALES del período
    const cierresPeriodo = (todosLosCierres || []).filter(c => {
      const esRealmenteFiscal = Boolean(
        c.esFiscal === true ||
        c.esFiscal === "true" ||
        c.modoFiscal === true ||
        c.modoFiscal === "true" ||
        c["ES_FISCAL"] === true ||
        c["ES_FISCAL"] === "true" ||
        c["NUMERO Z"] ||
        c.numeroZ
      );

      if (!esRealmenteFiscal) return false;

      const fStr = String(c["FECHA"] || c.fechaStr || "");
      const ts = parsearFechaTimestamp(fStr);
      if (ts > 0) {
        const dCierre = new Date(ts);
        return dCierre >= dDesde && dCierre <= dHasta;
      }
      return false;
    }).sort((a, b) => {
      return parsearFechaTimestamp(a["FECHA"] || a.fechaStr) - parsearFechaTimestamp(b["FECHA"] || b.fechaStr);
    });

    if (ventasPeriodo.length === 0 && cierresPeriodo.length === 0) {
      if (errorDiv) {
        errorDiv.textContent = `No se encontraron registros fiscales para el período seleccionado (${fechaDesdeStr} al ${fechaHastaStr}).`;
        errorDiv.classList.remove('hidden');
      }
      return;
    }

    // =========================================================================
    // SECCIÓN A: PROCESAMIENTO DE FACTURAS FISCALES
    // =========================================================================
    let filasSeniatFac = [];
    let totVentasBsFac = 0, totExentoBsFac = 0, totBase16BsFac = 0, totIVA16BsFac = 0;
    let totBase8BsFac = 0, totIVA8BsFac = 0, totIgtfBsFac = 0, totRetenidoBsFac = 0;
    let operacionNroFac = 1;

    ventasPeriodo.forEach(v => {
      const numFac = String(v.FACTURA || v["FACTURA N°"] || v.numFactura || "");
      const fechaStr = String(v["FECHA"] || v.fechaStr || "").split(',')[0].trim();
      const cedulaRIF = String(v["CEDULA O RIF"] || v.cedula || "V-00000000").trim();
      const clienteNombre = String(v["NOMBRE / RAZON SOCIAL"] || v.nombre || "CONSUMIDOR FINAL").trim();
      const montoTotalUSD = parseFloat(v["MONTO TOTAL"] || v.montoTotalUSD) || 0;
      const esNC = Boolean(v.esNotaCredito || numFac.startsWith("NC-") || String(v["FORMA DE PAGO"] || "").includes("NOTA DE CREDITO"));

      let totalVentaBs = Math.abs(montoTotalUSD) * tasaActual;
      const prodsStr = String(v["PRODUCTOS"] || v.productosSummary || "");
      
      let exentoBs = 0, base16Bs = 0, iva16Bs = 0, base8Bs = 0, iva8Bs = 0;

      if (prodsStr) {
        const itemsLista = prodsStr.split(' | ');
        itemsLista.forEach(itemTxt => {
          const matchUSD = itemTxt.match(/\$([0-9.]+)/);
          let montoItemUSD = matchUSD ? parseFloat(matchUSD[1]) : 0;
          let montoItemBs = montoItemUSD * tasaActual;
          const txtUpper = itemTxt.toUpperCase();

          let tasaItem = "E";
          if (txtUpper.includes('(G)') || txtUpper.includes('(16%)')) {
            tasaItem = "G";
          } else if (txtUpper.includes('(R)') || txtUpper.includes('(8%)')) {
            tasaItem = "R";
          } else {
            const matchNom = itemTxt.match(/^(.*?)(?:\s*\((.*?)\))?\s*-\s*\$/);
            const nomLimpio = matchNom ? matchNom[1].trim() : itemTxt.split('-')[0].trim();
            for (let cat of cacheCategoriasFactura) {
              let pCat = cat.productos.find(p => p[0] === nomLimpio);
              if (pCat) { tasaItem = (pCat[8] || "E").toUpperCase(); break; }
            }
          }

          if (tasaItem === "G" || tasaItem === "16") {
            let base = montoItemBs / 1.16;
            let iva = montoItemBs - base;
            base16Bs += base;
            iva16Bs += iva;
          } else if (tasaItem === "R" || tasaItem === "8") {
            let base = montoItemBs / 1.08;
            let iva = montoItemBs - base;
            base8Bs += base;
            iva8Bs += iva;
          } else {
            exentoBs += montoItemBs;
          }
        });
      }

      if ((exentoBs + base16Bs + base8Bs) === 0 && totalVentaBs > 0) {
        base16Bs = totalVentaBs / 1.16;
        iva16Bs = totalVentaBs - base16Bs;
      }

      let igtfBs = parseFloat(v.montoIGTF_BS || v["MONTO_IGTF_BS"] || v["IGTF"]) || 0;
      let compRet = String(v.comprobanteRetencion || v["COMPROBANTE_RETENCION"] || "").trim();
      let retencionBs = parseFloat(v.montoRetencionBS || v["MONTO_RETENCION_BS"] || v["IVA RETENIDO"]) || 0;

      let factorSigno = esNC ? -1 : 1;
      let finalTotalBs = totalVentaBs * factorSigno;
      let finalExentoBs = exentoBs * factorSigno;
      let finalBase16Bs = base16Bs * factorSigno;
      let finalIVA16Bs = iva16Bs * factorSigno;
      let finalBase8Bs = base8Bs * factorSigno;
      let finalIVA8Bs = iva8Bs * factorSigno;
      let finalIgtfBs = igtfBs * factorSigno;
      let finalRetencionBs = retencionBs * factorSigno;

      totVentasBsFac += finalTotalBs;
      totExentoBsFac += finalExentoBs;
      totBase16BsFac += finalBase16Bs;
      totIVA16BsFac += finalIVA16Bs;
      totBase8BsFac += finalBase8Bs;
      totIVA8BsFac += finalIVA8Bs;
      totIgtfBsFac += finalIgtfBs;
      totRetenidoBsFac += finalRetencionBs;

      let facAfectadaFinal = "";
      if (esNC) {
        facAfectadaFinal = v.facturaAfectada || v["FACTURA_AFECTADA"] || v["FACTURA AFECTADA"] || "";
        if (!facAfectadaFinal) {
          const textoPago = String(v["FORMA DE PAGO"] || v.formaPagoStr || "");
          const matchPago = textoPago.match(/AFECTA\s+(?:FACTURA|FACT)?\s*:?\s*([A-Za-z0-9\-_]+)/i);
          if (matchPago && matchPago[1]) facAfectadaFinal = matchPago[1].trim();
        }
        if (!facAfectadaFinal && v.direccion) {
          const matchDir = String(v.direccion).match(/AFECTA\s+(?:FACTURA|FACT)?\s*:?\s*([A-Za-z0-9\-_]+)/i);
          if (matchDir && matchDir[1]) facAfectadaFinal = matchDir[1].trim();
        }
      }

      filasSeniatFac.push({
        nroOperacion: operacionNroFac++,
        fecha: fechaStr,
        cedulaRIF: cedulaRIF,
        cliente: clienteNombre,
        numFactura: esNC ? "" : numFac,
        numControl: "N/A",
        notaDebito: "",
        notaCredito: esNC ? numFac : "",
        tipoTransaccion: esNC ? "02-NC" : "01-REG",
        facturaAfectada: facAfectadaFinal,
        totalVentaBs: finalTotalBs,
        exentoBs: finalExentoBs,
        base16Bs: finalBase16Bs,
        alicuota16: base16Bs > 0 ? "16%" : "",
        iva16Bs: finalIVA16Bs,
        base8Bs: finalBase8Bs,
        alicuota8: base8Bs > 0 ? "8%" : "",
        iva8Bs: finalIVA8Bs,
        igtfBs: finalIgtfBs,
        compRetencion: compRet,
        ivaRetenidoBs: finalRetencionBs
      });
    });

    // =========================================================================
    // SECCIÓN B: PROCESAMIENTO DE REPORTES Z (CONSOLIDACIÓN EXACTA 1:1 CON FACTURAS)
    // =========================================================================
    let filasSeniatZ = [];
    let totVentasBsZ = 0, totExentoBsZ = 0, totBase16BsZ = 0, totIVA16BsZ = 0;
    let totBase8BsZ = 0, totIVA8BsZ = 0, totIgtfBsZ = 0, totRetenidoBsZ = 0;
    let operacionNroZ = 1;

    // Agrupar facturas fiscales emitidas por fecha para calcular los totales reales del Reporte Z
    let mapaTotalesPorFecha = {};
    filasSeniatFac.forEach(f => {
      const fKey = f.fecha;
      if (!mapaTotalesPorFecha[fKey]) {
        mapaTotalesPorFecha[fKey] = {
          totalVentaBs: 0,
          exentoBs: 0,
          base16Bs: 0,
          iva16Bs: 0,
          base8Bs: 0,
          iva8Bs: 0,
          igtfBs: 0,
          ivaRetenidoBs: 0
        };
      }
      mapaTotalesPorFecha[fKey].totalVentaBs += f.totalVentaBs;
      mapaTotalesPorFecha[fKey].exentoBs += f.exentoBs;
      mapaTotalesPorFecha[fKey].base16Bs += f.base16Bs;
      mapaTotalesPorFecha[fKey].iva16Bs += f.iva16Bs;
      mapaTotalesPorFecha[fKey].base8Bs += f.base8Bs;
      mapaTotalesPorFecha[fKey].iva8Bs += f.iva8Bs;
      mapaTotalesPorFecha[fKey].igtfBs += f.igtfBs;
      mapaTotalesPorFecha[fKey].ivaRetenidoBs += f.ivaRetenidoBs;
    });

    cierresPeriodo.forEach(c => {
      const fechaStr = String(c["FECHA"] || c.fechaStr || "").split(',')[0].trim();
      const numReporteZ = String(c["NUMERO_Z"] || c["NUMERO Z"] || c.numeroZ || (c.id ? `Z-${String(c.id).padStart(4, '0')}` : `Z-${String(operacionNroZ).padStart(4, '0')}`));
      const serialMaquina = String(c["SERIAL"] || c.serial || serialFiscalPredeterminado);
      
      // Consolidar con las sumatorias exactas de las facturas de esa fecha
      const totalesDia = mapaTotalesPorFecha[fechaStr] || {
        totalVentaBs: parseFloat(c["TOTAL 2"] || c.totalVentasBS) || 0,
        exentoBs: 0,
        base16Bs: 0,
        iva16Bs: 0,
        base8Bs: 0,
        iva8Bs: 0,
        igtfBs: 0,
        ivaRetenidoBs: 0
      };

      let totalVentaBs = totalesDia.totalVentaBs;
      let exentoBs = totalesDia.exentoBs;
      let base16Bs = totalesDia.base16Bs;
      let iva16Bs = totalesDia.iva16Bs;
      let base8Bs = totalesDia.base8Bs;
      let iva8Bs = totalesDia.iva8Bs;
      let igtfBs = totalesDia.igtfBs;
      let retenidoBs = totalesDia.ivaRetenidoBs;

      totVentasBsZ += totalVentaBs;
      totExentoBsZ += exentoBs;
      totBase16BsZ += base16Bs;
      totIVA16BsZ += iva16Bs;
      totBase8BsZ += base8Bs;
      totIVA8BsZ += iva8Bs;
      totIgtfBsZ += igtfBs;
      totRetenidoBsZ += retenidoBs;

      filasSeniatZ.push({
        nroOperacion: operacionNroZ++,
        fecha: fechaStr,
        cedulaRIF: "-",
        cliente: "Ventas del día",
        numFactura: numReporteZ,
        numControl: serialMaquina,
        notaDebito: "-",
        notaCredito: "-",
        tipoTransaccion: "01-REG",
        facturaAfectada: "-",
        totalVentaBs: totalVentaBs,
        exentoBs: exentoBs,
        base16Bs: base16Bs,
        alicuota16: base16Bs !== 0 ? "16%" : "",
        iva16Bs: iva16Bs,
        base8Bs: base8Bs,
        alicuota8: base8Bs !== 0 ? "8%" : "",
        iva8Bs: iva8Bs,
        igtfBs: igtfBs,
        compRetencion: "-",
        ivaRetenidoBs: retenidoBs
      });
    });

    const encabezadoColumnas = [
      "N° Oper.", "Fecha", "RIF / C.I.", "Nombre / Razón Social", "N° Factura", 
      "N° Control", "N° Nota Déb.", "N° Nota Créd.", "Tipo Trans.", "Fact. Afectada",
      "Total Ventas Incl. IVA (Bs.)", "Ventas Exentas (Bs.)", "Base Imponible 16% (Bs.)", 
      "% Alic. 16%", "Impuesto IVA 16% (Bs.)", "Base Imponible 8% (Bs.)", "% Alic. 8%", 
      "Impuesto IVA 8% (Bs.)", "IGTF Percibido 3% (Bs.)", "N° Comprobante Ret.", "IVA Retenido (Bs.)"
    ];

    // =========================================================================
    // EXPORTACIÓN A EXCEL (.xlsx) CON 2 HOJAS
    // =========================================================================
    if (formato === 'excel') {
      // 1. Hoja 1: Facturas Fiscales
      const filasExcelFac = [
        ["FRIGORIFICO MUNDOCARNES, C.A."],
        ["RIF: J-505072889"],
        [`LIBRO DE VENTAS FISCAL - SENIAT (DETALLE DE FACTURAS EMITIDAS)`],
        [`Período de Imposición: ${mesNombre.toUpperCase()} ${anioFiscal} - (${periodoTexto}) | Tasa Ref: Bs. ${tasaActual.toFixed(2)}`],
        [],
        encabezadoColumnas
      ];

      filasSeniatFac.forEach(f => {
        filasExcelFac.push([
          f.nroOperacion, f.fecha, f.cedulaRIF, f.cliente, f.numFactura,
          f.numControl, f.notaDebito, f.notaCredito, f.tipoTransaccion, f.facturaAfectada,
          parseFloat(f.totalVentaBs.toFixed(2)), parseFloat(f.exentoBs.toFixed(2)), 
          parseFloat(f.base16Bs.toFixed(2)), f.alicuota16, parseFloat(f.iva16Bs.toFixed(2)),
          parseFloat(f.base8Bs.toFixed(2)), f.alicuota8, parseFloat(f.iva8Bs.toFixed(2)),
          f.igtfBs, f.compRetencion, f.ivaRetenidoBs
        ]);
      });

      filasExcelFac.push([]);
      filasExcelFac.push([
        "TOTALES:", "", "", "", "", "", "", "", "", "",
        parseFloat(totVentasBsFac.toFixed(2)), parseFloat(totExentoBsFac.toFixed(2)), 
        parseFloat(totBase16BsFac.toFixed(2)), "", parseFloat(totIVA16BsFac.toFixed(2)),
        parseFloat(totBase8BsFac.toFixed(2)), "", parseFloat(totIVA8BsFac.toFixed(2)),
        parseFloat(totIgtfBsFac.toFixed(2)), "", parseFloat(totRetenidoBsFac.toFixed(2))
      ]);

      // 2. Hoja 2: Reportes Z
      const filasExcelZ = [
        ["FRIGORIFICO MUNDOCARNES, C.A."],
        ["RIF: J-505072889"],
        [`LIBRO DE VENTAS FISCAL - SENIAT (RESUMEN DE REPORTES Z)`],
        [`Período de Imposición: ${mesNombre.toUpperCase()} ${anioFiscal} - (${periodoTexto}) | Serial Fiscal: ${serialFiscalPredeterminado}`],
        [],
        encabezadoColumnas
      ];

      filasSeniatZ.forEach(f => {
        filasExcelZ.push([
          f.nroOperacion, f.fecha, f.cedulaRIF, f.cliente, f.numFactura,
          f.numControl, f.notaDebito, f.notaCredito, f.tipoTransaccion, f.facturaAfectada,
          parseFloat(f.totalVentaBs.toFixed(2)), parseFloat(f.exentoBs.toFixed(2)), 
          parseFloat(f.base16Bs.toFixed(2)), f.alicuota16, parseFloat(f.iva16Bs.toFixed(2)),
          parseFloat(f.base8Bs.toFixed(2)), f.alicuota8, parseFloat(f.iva8Bs.toFixed(2)),
          f.igtfBs, f.compRetencion, f.ivaRetenidoBs
        ]);
      });

      filasExcelZ.push([]);
      filasExcelZ.push([
        "TOTALES:", "", "", "", "", "", "", "", "", "",
        parseFloat(totVentasBsZ.toFixed(2)), parseFloat(totExentoBsZ.toFixed(2)), 
        parseFloat(totBase16BsZ.toFixed(2)), "", parseFloat(totIVA16BsZ.toFixed(2)),
        parseFloat(totBase8BsZ.toFixed(2)), "", parseFloat(totIVA8BsZ.toFixed(2)),
        parseFloat(totIgtfBsZ.toFixed(2)), "", parseFloat(totRetenidoBsZ.toFixed(2))
      ]);

      const worksheetFac = XLSX.utils.aoa_to_sheet(filasExcelFac);
      const worksheetZ = XLSX.utils.aoa_to_sheet(filasExcelZ);
      const workbook = XLSX.utils.book_new();

      XLSX.utils.book_append_sheet(workbook, worksheetFac, "Facturas_Fiscales");
      XLSX.utils.book_append_sheet(workbook, worksheetZ, "Reportes_Z");

      const nombreArchivo = `Libro_Ventas_SENIAT_${mesNombre}_${anioFiscal}_${fechaDesdeStr}_al_${fechaHastaStr}.xlsx`;
      XLSX.writeFile(workbook, nombreArchivo);

      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFiltroDescarga')).hide();
      mostrarAvisoFactura("🎉 Libro de Ventas Fiscal SENIAT con Hoja de Reportes Z (.xlsx) generado con éxito.");

    } else {
      // =========================================================================
      // EXPORTACIÓN A PDF (LANDSCAPE CON SECCIÓN DE FACTURAS Y REPORTES Z)
      // =========================================================================
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

      const columnasPDF = [
        "N° Oper.", "Fecha", "RIF / C.I.", "Nombre / Razón Social", "N° Factura", "N° Control",
        "N° N.Déb.", "N° N.Créd.", "Tipo", "Fact. Afect.", "Total Ventas (Bs)", "Ventas Exentas (Bs)",
        "Base 16% (Bs)", "% 16%", "IVA 16% (Bs)", "Base 8% (Bs)", "% 8%", "IVA 8% (Bs)",
        "IGTF 3% (Bs)", "N° Comp. Ret.", "IVA Retenido (Bs)"
      ];

      // TABLA 1: FACTURAS FISCALES
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text("FRIGORIFICO MUNDOCARNES, C.A.", 14, 12);
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "normal");
      doc.text("RIF: J-505072889 | Dirección: Av. San Martín, Caracas, Distrito Capital", 14, 16);
      doc.setFont("helvetica", "bold");
      doc.text(`LIBRO DE VENTAS FISCAL - SENIAT (DETALLE DE FACTURAS EMITIDAS)`, 14, 20);
      doc.setFont("helvetica", "normal");
      doc.text(`Período de Imposición: ${mesNombre.toUpperCase()} ${anioFiscal} (${fechaDesdeStr} al ${fechaHastaStr}) | Tasa Ref: Bs. ${tasaActual.toFixed(2)}`, 14, 24);

      const filasPDFFac = filasSeniatFac.map(f => [
        f.nroOperacion,
        f.fecha,
        f.cedulaRIF,
        f.cliente.length > 17 ? f.cliente.substring(0, 17) + "..." : f.cliente,
        f.numFactura || "-",
        f.numControl || "N/A",
        f.notaDebito || "-",
        f.notaCredito || "-",
        f.tipoTransaccion,
        f.facturaAfectada || "-",
        f.totalVentaBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.exentoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.base16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.alicuota16 || "-",
        f.iva16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.base8Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.alicuota8 || "-",
        f.iva8Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.igtfBs > 0 ? f.igtfBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-",
        f.compRetencion || "-",
        f.ivaRetenidoBs > 0 ? f.ivaRetenidoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-"
      ]);

      filasPDFFac.push([
        "TOTAL", "", "", "RESUMEN FACTURAS", "", "", "", "", "", "",
        totVentasBsFac.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totExentoBsFac.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totBase16BsFac.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        "",
        totIVA16BsFac.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totBase8BsFac.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        "",
        totIVA8BsFac.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totIgtfBsFac.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        "",
        totRetenidoBsFac.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      ]);

      doc.autoTable({
        head: [columnasPDF],
        body: filasPDFFac,
        startY: 26,
        margin: { left: 5, right: 5 },
        theme: "grid",
        styles: { fontSize: 5.1, cellPadding: 0.7, halign: "center", lineColor: [200, 200, 200], lineWidth: 0.1, overflow: 'linebreak' },
        headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 5.1, halign: "center" },
        columnStyles: {
          3: { halign: "left", cellWidth: 23 },
          10: { halign: "right", fontStyle: "bold" },
          11: { halign: "right" },
          12: { halign: "right" },
          14: { halign: "right", textColor: [180, 0, 0] },
          15: { halign: "right" },
          17: { halign: "right" },
          18: { halign: "right" },
          19: { halign: "center", cellWidth: 18 },
          20: { halign: "right" }
        },
        footStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: "bold" }
      });

      // TABLA 2: REPORTES Z (EN NUEVA PÁGINA)
      if (filasSeniatZ.length > 0) {
        doc.addPage();
        doc.setFontSize(11);
        doc.setFont("helvetica", "bold");
        doc.text("FRIGORIFICO MUNDOCARNES, C.A.", 14, 12);
        doc.setFontSize(8.5);
        doc.setFont("helvetica", "normal");
        doc.text("RIF: J-505072889 | Dirección: Av. San Martín, Caracas, Distrito Capital", 14, 16);
        doc.setFont("helvetica", "bold");
        doc.text(`LIBRO DE VENTAS FISCAL - SENIAT (RESUMEN DE REPORTES Z)`, 14, 20);
        doc.setFont("helvetica", "normal");
        doc.text(`Período de Imposición: ${mesNombre.toUpperCase()} ${anioFiscal} (${fechaDesdeStr} al ${fechaHastaStr}) | Serial Fiscal: ${serialFiscalPredeterminado}`, 14, 24);

        const filasPDFZ = filasSeniatZ.map(f => [
          f.nroOperacion,
          f.fecha,
          f.cedulaRIF,
          f.cliente,
          f.numFactura,
          f.numControl,
          f.notaDebito,
          f.notaCredito,
          f.tipoTransaccion,
          f.facturaAfectada,
          f.totalVentaBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          f.exentoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          f.base16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          f.alicuota16 || "-",
          f.iva16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          f.base8Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          f.alicuota8 || "-",
          f.iva8Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          f.igtfBs > 0 ? f.igtfBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-",
          f.compRetencion || "-",
          f.ivaRetenidoBs > 0 ? f.ivaRetenidoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-"
        ]);

        filasPDFZ.push([
          "TOTAL", "", "", "RESUMEN REPORTES Z", "", "", "", "", "", "",
          totVentasBsZ.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          totExentoBsZ.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          totBase16BsZ.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          "",
          totIVA16BsZ.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          totBase8BsZ.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          "",
          totIVA8BsZ.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          totIgtfBsZ.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          "",
          totRetenidoBsZ.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        ]);

        doc.autoTable({
          head: [columnasPDF],
          body: filasPDFZ,
          startY: 26,
          margin: { left: 5, right: 5 },
          theme: "grid",
          styles: { fontSize: 5.1, cellPadding: 0.7, halign: "center", lineColor: [200, 200, 200], lineWidth: 0.1, overflow: 'linebreak' },
          headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 5.1, halign: "center" },
          columnStyles: {
            3: { halign: "left", cellWidth: 23 },
            10: { halign: "right", fontStyle: "bold" },
            11: { halign: "right" },
            12: { halign: "right" },
            14: { halign: "right", textColor: [180, 0, 0] },
            15: { halign: "right" },
            17: { halign: "right" },
            18: { halign: "right" },
            19: { halign: "center", cellWidth: 18 },
            20: { halign: "right" }
          },
          footStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: "bold" }
        });
      }

      const nombreArchivoPDF = `Libro_Ventas_SENIAT_${mesNombre}_${anioFiscal}_${fechaDesdeStr}_al_${fechaHastaStr}.pdf`;
      doc.save(nombreArchivoPDF);

      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFiltroDescarga')).hide();
      mostrarAvisoFactura("🎉 Libro de Ventas Fiscal SENIAT con Reportes Z (.pdf) exportado con éxito.");
    }

  } catch (errSeniat) {
    console.error("Error al generar Libro SENIAT:", errSeniat);
    if (errorDiv) {
      errorDiv.textContent = "Error al generar el Libro SENIAT: " + errSeniat.message;
      errorDiv.classList.remove('hidden');
    }
  }
}

// MOVIMIENTOS DE EFECTIVO PERSISTENTES AISLADOS POR USUARIO
function cargarMovimientosEfectivoPersistentes() {
  const hoy = new Date().toISOString().split('T')[0];
  const usuario = obtenerUsuarioActivo();
  const claveMov = `movimientos_efectivo_${usuario}_${hoy}`;
  const guardado = localStorage.getItem(claveMov);
  if (guardado) {
    try {
      listaMovimientosEfectivo = JSON.parse(guardado) || [];
    } catch (e) {
      listaMovimientosEfectivo = [];
    }
  } else {
    listaMovimientosEfectivo = [];
  }
}

function abrirModalMovimientosEfectivo() {
  document.getElementById('movMontoInput').value = "";
  document.getElementById('movConceptoInput').value = "";
  document.getElementById('movTipoSelect').value = "INGRESO";
  document.getElementById('movMonedaSelect').value = "USD";
  if (document.getElementById('movSubtipoSelect')) {
    document.getElementById('movSubtipoSelect').value = "MANUAL";
  }

  evaluarTipoMovimiento("INGRESO");

  document.getElementById('errorModalMovEfectivo').classList.add('hidden');
  document.getElementById('contenedorTablaMovimientosDia').classList.add('hidden');

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalMovimientosEfectivo')).show();
}

function evaluarTipoMovimiento(tipoVal) {
  const contSubtipo = document.getElementById('contMovSubtipo');
  const contVale = document.getElementById('contMovValeCaja');
  const contConcepto = document.getElementById('contMovConceptoManual');

  if (tipoVal === 'RETIRO') {
    if (contSubtipo) contSubtipo.classList.remove('hidden');
    const subtipoVal = document.getElementById('movSubtipoSelect') ? document.getElementById('movSubtipoSelect').value : 'MANUAL';
    evaluarSubtipoMovimiento(subtipoVal);
  } else {
    if (contSubtipo) contSubtipo.classList.add('hidden');
    if (contVale) contVale.classList.add('hidden');
    if (contConcepto) contConcepto.classList.remove('hidden');
  }
}

function evaluarSubtipoMovimiento(subtipoVal) {
  const contVale = document.getElementById('contMovValeCaja');
  const contConcepto = document.getElementById('contMovConceptoManual');

  if (subtipoVal === 'VALE') {
    if (contVale) contVale.classList.remove('hidden');
    if (contConcepto) contConcepto.classList.add('hidden');
  } else {
    if (contVale) contVale.classList.add('hidden');
    if (contConcepto) contConcepto.classList.remove('hidden');
  }
}

async function registrarMovimientoEfectivo() {
  const tipo = document.getElementById('movTipoSelect').value;
  const moneda = document.getElementById('movMonedaSelect').value;
  const monto = parseFloat(document.getElementById('movMontoInput').value);
  const errorDiv = document.getElementById('errorModalMovEfectivo');

  const esEgresoVale = (tipo === 'RETIRO') && (document.getElementById('movSubtipoSelect').value === 'VALE');

  if (isNaN(monto) || monto <= 0) {
    errorDiv.textContent = "Por favor, indique un monto válido superior a 0.";
    errorDiv.classList.remove('hidden');
    return;
  }

  let conceptoFinal = "";
  let datosVale = null;

  if (esEgresoVale) {
    const empNombre = document.getElementById('valeEmpleadoNombre').value.trim().toUpperCase();
    const empCedula = document.getElementById('valeEmpleadoCedula').value.trim().toUpperCase();
    const motivoVal = document.getElementById('valeMotivo').value.trim().toUpperCase();
    const cuotasVal = document.getElementById('valeCuotas').value;
    const autPor = document.getElementById('valeAutorizadoPor').value.trim().toUpperCase();

    if (!empNombre || !empCedula || !motivoVal || !autPor) {
      errorDiv.textContent = "Complete todos los campos requeridos del Vale de Caja.";
      errorDiv.classList.remove('hidden');
      return;
    }

    conceptoFinal = `VALE DE CAJA: ${empNombre} (CI: ${empCedula}) - ${motivoVal} [${cuotasVal} CUOTA(S)] - AUT: ${autPor}`;

    const usuarioActivo = obtenerUsuarioActivo().toUpperCase();
    const fechaHoraActual = new Date().toLocaleString('es-VE');

    datosVale = {
      fechaHora: fechaHoraActual,
      empleadoNombre: empNombre,
      empleadoCedula: empCedula,
      motivo: motivoVal,
      monto: monto,
      moneda: moneda,
      cuotas: cuotasVal,
      autorizadoPor: autPor,
      usuario: usuarioActivo,
      estatus: "PENDIENTE",
      fechaPago: null
    };

    const localId = await dbPut("vales", {
      FECHA: fechaHoraActual,
      EMPLEADO: empNombre,
      CEDULA: empCedula,
      MONTO: monto,
      MONEDA: moneda,
      MOTIVO: motivoVal,
      CUOTAS: String(cuotasVal),
      "AUTORIZADO POR": autPor,
      USUARIO: usuarioActivo,
      ESTATUS: "PENDIENTE",
      "FECHA PAGO": null
    });

    await dbPut("syncQueue", {
      id: "sync_vale_" + Date.now(),
      payload: {
        action: "guardarVale",
        localId: localId,
        datosVale: datosVale
      }
    });

  } else {
    conceptoFinal = document.getElementById('movConceptoInput').value.trim().toUpperCase();
    if (!conceptoFinal) {
      errorDiv.textContent = "Especifique el concepto o motivo del movimiento.";
      errorDiv.classList.remove('hidden');
      return;
    }
  }

  errorDiv.classList.add('hidden');

  const nuevoMov = {
    hora: new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }),
    tipo: tipo,
    moneda: moneda,
    monto: monto,
    concepto: conceptoFinal,
    datosVale: datosVale || null,
    fechaCompleta: new Date().toLocaleString('es-VE')
  };

  listaMovimientosEfectivo.push(nuevoMov);
  await dbPut("movimientos", nuevoMov);

  const hoy = new Date().toISOString().split('T')[0];
  const usuario = obtenerUsuarioActivo();
  localStorage.setItem(`movimientos_efectivo_${usuario}_${hoy}`, JSON.stringify(listaMovimientosEfectivo));

  document.getElementById('movMontoInput').value = "";
  document.getElementById('movConceptoInput').value = "";
  document.getElementById('valeEmpleadoNombre').value = "";
  document.getElementById('valeEmpleadoCedula').value = "";
  document.getElementById('valeMotivo').value = "";
  document.getElementById('valeAutorizadoPor').value = "";

  renderizarTablaMovimientosDia();

  if (esEgresoVale && datosVale) {
    renderizarTicketValeCajaHTML(datosVale);
    const ticketHtml = document.getElementById('contenidoTicketImprimible').innerHTML;
    ejecutarImpresionTicket(ticketHtml);
    mostrarAvisoFactura(`🎟️ Vale de Caja para ${datosVale.empleadoNombre} registrado e impreso.`);
    procesarColaSincronizacion();
  } else {
    mostrarAvisoFactura(`💸 Movimiento de ${tipo} (${moneda}) registrado exitosamente.`);
  }
}

function renderizarTicketValeCajaHTML(d) {
  let montoTxt = (d.moneda === "BS" || d.MONEDA === "BS")
    ? `Bs. ${parseFloat(d.monto || d.MONTO).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${parseFloat(d.monto || d.MONTO).toFixed(2)}`;

  let fec = d.fechaHora || d.FECHA || new Date().toLocaleString('es-VE');
  let emp = d.empleadoNombre || d.EMPLEADO || 'EMPLEADO';
  let ced = d.empleadoCedula || d.CEDULA || 'N/D';
  let mot = d.motivo || d.MOTIVO || 'ADELANTO DE SUELDO';
  let cuo = d.cuotas || d.CUOTAS || '1';
  let aut = d.autorizadoPor || d["AUTORIZADO POR"] || 'GERENCIA';
  let est = (d.estatus || d.ESTATUS || 'PENDIENTE').toUpperCase();

  const ticketHtml = `
    <div class="ticket-container shadow-sm border text-start">
      <div class="ticket-header">
        <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
        <div class="ticket-title fs-6">VALE DE CAJA - EGRESO</div>
        <div>RIF: J-505072889 | TELF: 0412-1753275</div>
        <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
      </div>

      <div class="ticket-info">
        <div><strong>FECHA Y HORA:</strong> <span class="num-legible">${fec}</span></div>
        <div><strong>CONCEPTO:</strong> ADELANTO DE SUELDO</div>
        <div><strong>ESTATUS:</strong> <strong>${est}</strong></div>
      </div>

      <div class="ticket-box-info">
        <div><strong>EMPLEADO:</strong> ${emp}</div>
        <div><strong>CÉDULA / CI:</strong> <span class="num-legible">${ced}</span></div>
        <div><strong>MOTIVO:</strong> ${mot}</div>
        <div><strong>MONTO DEL VALE:</strong> <span class="fs-6 font-weight-bold num-legible">${montoTxt}</span></div>
        <div><strong>CUOTAS A DESCONTAR:</strong> ${cuo} cuota(s)</div>
        <div><strong>AUTORIZADO POR:</strong> ${aut}</div>
      </div>

      <div class="small text-muted text-justify mt-2 mb-3" style="font-size: 8.5px; line-height: 1.2;">
        Conste por la presente la recepción conforme del dinero arriba indicado y la expresa autorización para descontar dicho monto en la(s) cuota(s) establecida(s).
      </div>

      <div class="ticket-firma-linea">
        ____________________________________<br>
        FIRMA Y CONFORMIDAD EMPLEADO<br>
        CI: <span class="num-legible">${ced}</span>
      </div>

      <div class="ticket-footer mt-3">
        <div class="small">COMPROBANTE OPERATIVO DE CAJA</div>
      </div>
    </div>
  `;

  const elemImpresion = document.getElementById('contenidoTicketImprimible');
  if (elemImpresion) elemImpresion.innerHTML = ticketHtml;
}

function alternarTablaMovimientosDia() {
  const cont = document.getElementById('contenedorTablaMovimientosDia');
  if (cont.classList.contains('hidden')) {
    renderizarTablaMovimientosDia();
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }
}

function renderizarTablaMovimientosDia() {
  const tbody = document.getElementById('tablaMovimientosDiaCaja');
  if (!tbody) return;

  if (listaMovimientosEfectivo.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">No hay movimientos registrados hoy.</td></tr>`;
    return;
  }

  let html = "";
  listaMovimientosEfectivo.forEach((m, idx) => {
    let esIngreso = (m.tipo === "INGRESO");
    let badgeTipo = esIngreso ? `<span class="badge bg-success">INGRESO (+)</span>` : `<span class="badge bg-danger">EGRESO (-)</span>`;
    let montoTxt = (m.moneda === "BS") 
      ? `Bs. ${m.monto.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `$${m.monto.toFixed(2)}`;

    html += `
      <tr>
        <td class="text-center small num-legible">${m.hora}</td>
        <td class="text-center">${badgeTipo}</td>
        <td class="text-center fw-bold">${m.moneda}</td>
        <td class="text-end fw-bold ${esIngreso ? 'text-success' : 'text-danger'} num-legible">${montoTxt}</td>
        <td class="small text-wrap">${m.concepto}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fw-bold rounded-pill" onclick="eliminarMovimientoEfectivo(${idx})" title="Eliminar">
            🗑️
          </button>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

function eliminarMovimientoEfectivo(index) {
  if (confirm("¿Está seguro de que desea eliminar este movimiento de efectivo?")) {
    const mov = listaMovimientosEfectivo[index];
    listaMovimientosEfectivo.splice(index, 1);

    const hoy = new Date().toISOString().split('T')[0];
    const usuario = obtenerUsuarioActivo();
    localStorage.setItem(`movimientos_efectivo_${usuario}_${hoy}`, JSON.stringify(listaMovimientosEfectivo));

    renderizarTablaMovimientosDia();
    mostrarAvisoFactura(`🗑️ Movimiento de ${mov.tipo} (${mov.moneda}) eliminado.`);
  }
}

// Validar si ya existe un cierre registrado hoy para la modalidad activa (Fiscal vs No Fiscal)
function verificarCierreExistenteHoy(esFiscalObjetivo) {
  const usuario = obtenerUsuarioActivo();
  const hoy = new Date();
  const hoyDia = hoy.getDate();
  const hoyMes = hoy.getMonth();
  const hoyAnio = hoy.getFullYear();

  for (let c of cacheHistorialCierres) {
    const userFila = normalizarUsuario(c.usuario || usuario);
    if (userFila === usuario) {
      const fStr = String(c.fechaStr || c["FECHA"] || "");
      const ts = parsearFechaTimestamp(fStr);
      let esDeHoy = false;

      if (ts > 0) {
        const dCierre = new Date(ts);
        esDeHoy = (dCierre.getFullYear() === hoyAnio && dCierre.getMonth() === hoyMes && dCierre.getDate() === hoyDia);
      } else {
        const dStr = String(hoyDia).padStart(2, '0');
        const mStr = String(hoyMes + 1).padStart(2, '0');
        esDeHoy = fStr.includes(`${hoyDia}/${hoyMes + 1}/${hoyAnio}`) || fStr.includes(`${dStr}/${mStr}/${hoyAnio}`);
      }

      if (esDeHoy) {
        const cEsFiscal = Boolean(c.esFiscal === true || c.esFiscal === "true" || c.modoFiscal === true || c.modoFiscal === "true" || c["ES_FISCAL"] === true || c["ES_FISCAL"] === "true" || c["NUMERO_Z"] || c["NUMERO Z"] || c.numeroZ);
        if (cEsFiscal === esFiscalObjetivo) {
          return c;
        }
      }
    }
  }
  return null;
}

// CIERRE DE CAJA (VALIDACIÓN DE MÁXIMO 1 CIERRE NO FISCAL Y 1 CIERRE FISCAL POR DÍA)
async function abrirModalCierreCaja() {
  const usuario = obtenerUsuarioActivo();
  const elemUsuario = document.getElementById('cierreUsuarioNombre');
  if (elemUsuario) {
    elemUsuario.textContent = `👤 Cajero: ${usuario.toUpperCase()}`;
  }

  // Cargar historial de cierres para validar en tiempo real
  await cargarHistorialCierresCaja();

  const cierreExistente = verificarCierreExistenteHoy(modoFiscalActivo);
  const btnSiguiente = document.getElementById('btnSiguienteCierreCaja');
  const errorDiv = document.getElementById('errorModalCierrePaso1');

  if (cierreExistente) {
    const tipoStr = modoFiscalActivo ? "Cierre Fiscal (Reporte Z)" : "Cierre de Control Interno (No Fiscal)";
    const reglaStr = modoFiscalActivo 
      ? "Por normativa legal del SENIAT solo se permite emitir 1 Reporte Z por día." 
      : "Solo se permite emitir 1 cierre de control interno por jornada diaria.";

    if (errorDiv) {
      errorDiv.innerHTML = `⚠️ <strong>CIERRE YA REGISTRADO HOY:</strong><br>Ya se ha emitido el <strong>${tipoStr}</strong> de hoy (${cierreExistente.fechaStr}).<br><small class="text-muted">${reglaStr}</small>`;
      errorDiv.classList.remove('hidden');
    }
    if (btnSiguiente) {
      btnSiguiente.disabled = true;
      btnSiguiente.classList.add('disabled');
    }
  } else {
    if (errorDiv) errorDiv.classList.add('hidden');
    if (btnSiguiente) {
      btnSiguiente.disabled = false;
      btnSiguiente.classList.remove('disabled');
    }
  }

  const hoy = new Date().toISOString().split('T')[0];
  const claveApertura = `apertura_caja_user_${usuario}_${hoy}`;
  const aperturaGuardada = localStorage.getItem(claveApertura);

  if (aperturaGuardada) {
    try {
      const datos = JSON.parse(aperturaGuardada);
      document.getElementById('cierreInicialUSD').value = (parseFloat(datos.usd) || 0).toFixed(2);
      document.getElementById('cierreInicialBS').value = (parseFloat(datos.bs) || 0).toFixed(2);
    } catch (e) {
      document.getElementById('cierreInicialUSD').value = "0.00";
      document.getElementById('cierreInicialBS').value = "0.00";
    }
  } else {
    document.getElementById('cierreInicialUSD').value = "0.00";
    document.getElementById('cierreInicialBS').value = "0.00";
  }

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCierreCajaPaso1')).show();
}

async function cargarHistorialCierresCaja() {
  const tbody = document.getElementById('tablaHistorialCierresCaja');
  if (!tbody) return;

  const usuarioActivo = obtenerUsuarioActivo();
  const tablaCierresUsuario = obtenerTablaCierresUsuario(usuarioActivo);

  let cierresLocales = await dbGetAll("cierres");
  let cierresFiltrados = cierresLocales.filter(c => normalizarUsuario(c.usuario) === usuarioActivo);

  if (cierresFiltrados.length > 0) {
    cacheHistorialCierres = cierresFiltrados.sort((a, b) => (b.id || 0) - (a.id || 0));
    renderizarTablaHistorialCierres();
  } else {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">⏳ Consultando cierres de ${usuarioActivo.toUpperCase()}...</td></tr>`;
  }

  if (navigator.onLine) {
    try {
      const { data: cierresSup, error } = await supabaseClient.from(tablaCierresUsuario).select('*');
      if (!error && cierresSup && cierresSup.length > 0) {
        cacheHistorialCierres = cierresSup.map((c, idx) => {
          const idSeguro = c.id || (c["FECHA"] ? parsearFechaTimestamp(c["FECHA"]) : null) || (Date.now() + idx);
          return {
            id: idSeguro,
            fechaStr: c["FECHA"] || "",
            usuario: usuarioActivo,
            inicialUSD: parseFloat(c["INICIAL $"]) || 0,
            inicialBS: parseFloat(c["INICIAL Bs"]) || 0,
            cajaFinalUSD: parseFloat(c["TOTAL 3"]) || 0,
            cajaFinalBS: parseFloat(c["TOTAL 4"]) || 0,
            totalVentasUSD: parseFloat(c["TOTAL 1"]) || 0,
            totalVentasBS: parseFloat(c["TOTAL 2"]) || 0,
            esFiscal: Boolean(c["ES_FISCAL"] || c.esFiscal || c.modoFiscal || c["NUMERO_Z"] || c["NUMERO Z"] || c.numeroZ),
            modoFiscal: Boolean(c["ES_FISCAL"] || c.esFiscal || c.modoFiscal || c["NUMERO_Z"] || c["NUMERO Z"] || c.numeroZ),
            numeroZ: c["NUMERO_Z"] || c["NUMERO Z"] || c.numeroZ || null,
            resumen: {
              ventasEfectivoUSD: parseFloat(c["DIVISAS"]) || 0,
              ventasEfectivoBS: parseFloat(c["BOLIVARES"]) || 0,
              ventasPagoMovil: parseFloat(c["PAGO MOVIL"]) || 0,
              ventasZelle: parseFloat(c["ZELLE"]) || 0,
              ventasPayPal: parseFloat(c["PAYPAL"]) || 0,
              ventasPuntoVenta: parseFloat(c["PUNTO DE VENTA"]) || 0,
              ventasBiopago: parseFloat(c["BIOPAGO"]) || 0,
              ventasCashea: parseFloat(c["CASHEA"]) || 0,
              ventasCredito: parseFloat(c["CREDITO"]) || 0,
              ventasTransferencia: parseFloat(c["TRANSFERENCIA"] || c["TRANSFERECIA"]) || 0,
              totalGeneralVentasUSD: parseFloat(c["TOTAL 1"]) || 0,
              totalGeneralVentasBS: parseFloat(c["TOTAL 2"]) || 0
            }
          };
        }).sort((a, b) => (b.id || 0) - (a.id || 0));

        for (let c of cacheHistorialCierres) {
          await dbPut("cierres", c);
        }
        renderizarTablaHistorialCierres();
      } else if (!error && (!cierresSup || cierresSup.length === 0)) {
        cacheHistorialCierres = [];
        renderizarTablaHistorialCierres();
      }
    } catch (e) {}
  }
}

function renderizarTablaHistorialCierres() {
  const tbody = document.getElementById('tablaHistorialCierresCaja');
  if (!tbody) return;

  if (cacheHistorialCierres.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">No hay cierres de caja registrados para este usuario.</td></tr>`;
    return;
  }

  let html = "";
  cacheHistorialCierres.forEach((c, idx) => {
    let fStr = c.fechaStr || 'N/D';
    let uStr = c.usuario || 'CAJERO';
    const esFiscalCierre = Boolean(c.esFiscal === true || c.esFiscal === "true" || c.modoFiscal === true || c.modoFiscal === "true" || c.numeroZ || c["ES_FISCAL"] || c["NUMERO Z"]);
    let badgeTipoCierre = esFiscalCierre 
      ? `<span class="badge bg-primary fw-bold">🏷️ Z Fiscal ${c.numeroZ ? '#' + c.numeroZ : ''}</span>` 
      : `<span class="badge bg-secondary">📄 Z Interno</span>`;

    let iniUSD = (parseFloat(c.inicialUSD) || 0).toFixed(2);
    let iniBS = (parseFloat(c.inicialBS) || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let venUSD = (parseFloat(c.totalVentasUSD) || 0).toFixed(2);
    let venBS = (parseFloat(c.totalVentasBS) || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let finUSD = (parseFloat(c.cajaFinalUSD) || 0).toFixed(2);
    let finBS = (parseFloat(c.cajaFinalBS) || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    html += `
      <tr>
        <td class="fw-bold text-center small num-legible">${fStr}</td>
        <td class="fw-bold text-center">${uStr}</td>
        <td class="text-center">${badgeTipoCierre}</td>
        <td class="text-center small num-legible">$${iniUSD} / Bs.${iniBS}</td>
        <td class="text-center small num-legible">$${venUSD} / Bs.${venBS}</td>
        <td class="text-center fw-bold text-success num-legible">$${finUSD} / Bs.${finBS}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-primary py-0 px-2 fw-bold rounded-pill me-1" onclick="reimprimirCierreCajaHistorial(${idx})" title="Reimprimir Reporte Z">
            🖨️ Imprimir
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fw-bold rounded-pill" onclick="eliminarCierreCajaHistorial(${idx})" title="Eliminar Registro de Cierre">
            🗑️
          </button>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

function reimprimirCierreCajaHistorial(idx) {
  const c = cacheHistorialCierres[idx];
  if (!c) return mostrarAvisoFactura("No se localizó la información del cierre.");

  datosCierreCajaPendiente = {
    fechaStr: c.fechaStr || new Date().toLocaleString('es-VE'),
    usuario: c.usuario || "CAJERO",
    tasaBCV: c.tasaBCV || obtenerTasaBCV(),
    inicialUSD: parseFloat(c.inicialUSD) || 0,
    inicialBS: parseFloat(c.inicialBS) || 0,
    resumen: c.resumen || {},
    ingresosUSD: 0,
    retirosUSD: 0,
    ingresosBS: 0,
    retirosBS: 0,
    totalCajaUSD: parseFloat(c.cajaFinalUSD) || 0,
    totalCajaBS: parseFloat(c.cajaFinalBS) || 0,
    modoFiscal: c.esFiscal || false
  };

  renderizarTicketCierreCajaHTML(datosCierreCajaPendiente);
  const ticketHtml = document.getElementById('contenidoTicketImprimible').innerHTML;
  ejecutarImpresionTicket(ticketHtml);
  mostrarAvisoFactura(`🖨️ Reimprimiendo Reporte Z del ${c.fechaStr}...`);
}

async function eliminarCierreCajaHistorial(idx) {
  const c = cacheHistorialCierres[idx];
  if (!c) return;

  if (!confirm(`⚠️ ¿Está seguro que desea eliminar este registro de Cierre de Caja (${c.fechaStr} - ${c.usuario})?`)) {
    return;
  }

  const idCierre = c.id;
  const fechaCierre = c.fechaStr;
  const usuarioCierre = c.usuario;
  const tablaCierres = obtenerTablaCierresUsuario(usuarioCierre);

  cacheHistorialCierres.splice(idx, 1);
  renderizarTablaHistorialCierres();

  if (idCierre) {
    await dbDelete("cierres", idCierre);
  }
  const todosCierresLocales = await dbGetAll("cierres");
  for (let cie of todosCierresLocales) {
    if (cie.fechaStr === fechaCierre) {
      await dbDelete("cierres", cie.id);
    }
  }

  await dbPut("syncQueue", {
    id: "sync_del_cie_" + Date.now(),
    payload: {
      action: "eliminarCierreCaja",
      id: idCierre,
      fechaStr: fechaCierre,
      usuario: usuarioCierre,
      tablaCierres: tablaCierres
    }
  });

  mostrarAvisoFactura("🗑️ Cierre de caja eliminado con éxito.");
  procesarColaSincronizacion();
}

async function procesarSiguienteCierreCaja() {
  const inicialUSD = parseFloat(document.getElementById('cierreInicialUSD').value) || 0;
  const inicialBS = parseFloat(document.getElementById('cierreInicialBS').value) || 0;
  const btn = document.getElementById('btnSiguienteCierreCaja');
  const usuario = obtenerUsuarioActivo();
  const tablaUsuarioActivo = obtenerTablaVentasUsuario(usuario);

  const hoyStr = new Date().toISOString().split('T')[0];
  localStorage.setItem(`apertura_caja_user_${usuario}_${hoyStr}`, JSON.stringify({
    usd: inicialUSD,
    bs: inicialBS,
    fechaHora: new Date().toLocaleString('es-VE')
  }));

  btn.disabled = true;
  btn.textContent = "Calculando ventas del usuario...";

  try {
    const tasa = obtenerTasaBCV();
    const factorTasa = tasa > 0 ? tasa : 1;

    // 1. Acumuladores de Control Interno (Discriminación Estricta por Moneda de Origen)
    let resumenGeneral = {
      ventasEfectivoUSD: 0, ventasEfectivoBS: 0, ventasPagoMovil: 0,
      ventasZelle: 0, ventasPayPal: 0, ventasCashea: 0, ventasCredito: 0,
      ventasPuntoVenta: 0, ventasTransferencia: 0, ventasBiopago: 0,
      totalGeneralVentasUSD: 0, // Suma exclusiva: Efectivo Divisas + Zelle + PayPal + Cashea
      totalGeneralVentasBS: 0   // Suma exclusiva: Efectivo Bs + Pago Móvil + Punto de Venta + Biopago + Transferencia
    };

    // 2. Acumuladores Fiscales Exclusivos Dinámicos (Únicamente ventas fiscales del usuario activo)
    let resumenFiscal = {
      ventasEfectivoUSD: 0, ventasEfectivoBS: 0, ventasPagoMovil: 0,
      ventasZelle: 0, ventasPayPal: 0, ventasCashea: 0, ventasCredito: 0,
      ventasPuntoVenta: 0, ventasTransferencia: 0, ventasBiopago: 0,
      totalFiscalUSD: 0, totalFiscalBS: 0,
      cantFacturasFiscales: 0,
      cantNCFiscales: 0,
      exentoBS: 0,
      base16BS: 0,
      iva16BS: 0,
      ncExentoBS: 0,
      ncBase16BS: 0,
      ncIVA16BS: 0,
      ncTotalBS: 0,
      facturaInicialFiscal: null, facturaFinalFiscal: null,
      ncFinalFiscal: null,
      listaFacturasFiscales: [],
      listaNCFiscales: []
    };

    // 3. Obtener ventas filtrando ESTRICTAMENTE por el usuario activo
    let mapVentasHoy = {};
    const ventasLocales = await dbGetAll("ventas");
    if (Array.isArray(ventasLocales)) {
      ventasLocales.forEach(v => {
        if (v && v.numFactura) {
          const userFila = normalizarUsuario(v.usuario);
          // Aislamiento total: solo incluir si pertenece al usuario activo de la sesión
          if (userFila === usuario) {
            mapVentasHoy[String(v.numFactura)] = { ...v };
          }
        }
      });
    }

    if (navigator.onLine) {
      try {
        const ventasSup = await obtenerTodasLasVentasSupabase(tablaUsuarioActivo);
        if (Array.isArray(ventasSup)) {
          ventasSup.forEach(v => {
            let numFac = v.FACTURA || v["FACTURA N°"] || v.numFactura;
            if (numFac) {
              mapVentasHoy[String(numFac)] = {
                ...v,
                numFactura: String(numFac),
                fechaStr: v["FECHA"] || v.fechaStr || "",
                montoTotalUSD: parseFloat(v["MONTO TOTAL"] || v.montoTotalUSD) || 0,
                formaPagoStr: v["FORMA DE PAGO"] || v.formaPagoStr || "",
                productosSummary: v["PRODUCTOS"] || v.productosSummary || "",
                usuario: usuario,
                esFiscal: Boolean(String(v["FORMA DE PAGO"] || "").includes("FISCAL") || v.esFiscal),
                "EFECTIVO DIVISAS": v["EFECTIVO DIVISAS"],
                "EFECTIVO BOLIVARES": v["EFECTIVO BOLIVARES"],
                "PAGO MOVIL": v["PAGO MOVIL"],
                "ZELLE": v["ZELLE"],
                "PAYPAL": v["PAYPAL"],
                "CASHEA": v["CASHEA"],
                "CREDITO": v["CREDITO"],
                "PUNTO DE VENTA": v["PUNTO DE VENTA"],
                "TRANSFERENCIA": v["TRANSFERENCIA"] || v["TRANSFERECIA"],
                "BIOPAGO": v["BIOPAGO"]
              };
            }
          });
        }
      } catch (errSup) {
        console.warn("Aviso Supabase cierre:", errSup);
      }
    }

    const hoy = new Date();
    const hoyDia = hoy.getDate();
    const hoyMes = hoy.getMonth();
    const hoyAnio = hoy.getFullYear();

    // 4. Procesar ventas de hoy del usuario activo
    Object.values(mapVentasHoy).forEach(v => {
      const fStr = String(v["FECHA"] || v.fechaStr || "");
      const ts = parsearFechaTimestamp(fStr);
      let esVentaDeHoy = false;

      if (ts > 0) {
        const dVenta = new Date(ts);
        esVentaDeHoy = (dVenta.getFullYear() === hoyAnio && dVenta.getMonth() === hoyMes && dVenta.getDate() === hoyDia);
      } else {
        const dStr = String(hoyDia).padStart(2, '0');
        const mStr = String(hoyMes + 1).padStart(2, '0');
        esVentaDeHoy = fStr.includes(`${hoyDia}/${hoyMes + 1}/${hoyAnio}`) || fStr.includes(`${dStr}/${mStr}/${hoyAnio}`) || fStr.startsWith(hoyStr);
      }

      if (esVentaDeHoy) {
        const formaStr = String(v["FORMA DE PAGO"] || v.formaPagoStr || "").toUpperCase();
        const numFac = String(v.FACTURA || v.numFactura || "");
        const esFiscal = Boolean(v.esFiscal || formaStr.includes("FISCAL") || numFac.startsWith("FAC-") || /^\d{8}$/.test(numFac));
        const totalVentaUSD = parseFloat(v["MONTO TOTAL"] || v.montoTotalUSD) || 0;

        let evUSD = parseFloat(v["EFECTIVO DIVISAS"] || v.efectivoDivisas) || 0;
        let evBS = parseFloat(v["EFECTIVO BOLIVARES"] || v.efectivoBolivares) || 0;
        let pmBS = parseFloat(v["PAGO MOVIL"] || v.pagoMovil) || 0;
        let zUSD = parseFloat(v["ZELLE"] || v.zelle) || 0;
        let ppUSD = parseFloat(v["PAYPAL"] || v.paypal) || 0;
        let cUSD = parseFloat(v["CASHEA"] || v.cashea) || 0;
        let crUSD = parseFloat(v["CREDITO"] || v.credito) || 0;
        let pvBS = parseFloat(v["PUNTO DE VENTA"] || v.puntoDeVenta) || 0;
        let trBS = parseFloat(v["TRANSFERENCIA"] || v["TRANSFERECIA"] || v.transferencia) || 0;
        let bioBS = parseFloat(v["BIOPAGO"] || v.biopago) || 0;

        let sumaDesglose = evUSD + zUSD + ppUSD + cUSD + crUSD + evBS + pmBS + pvBS + trBS + bioBS;

        // A. Acumular en Resumen General
        if (sumaDesglose > 0) {
          resumenGeneral.ventasEfectivoUSD += evUSD;
          resumenGeneral.ventasEfectivoBS += evBS;
          resumenGeneral.ventasPagoMovil += pmBS;
          resumenGeneral.ventasZelle += zUSD;
          resumenGeneral.ventasPayPal += ppUSD;
          resumenGeneral.ventasCashea += cUSD;
          resumenGeneral.ventasCredito += crUSD;
          resumenGeneral.ventasPuntoVenta += pvBS;
          resumenGeneral.ventasTransferencia += trBS;
          resumenGeneral.ventasBiopago += bioBS;
        } else {
          // Fallback por texto si no existiera desglose en columnas
          if (formaStr.includes("CASHEA")) {
            resumenGeneral.ventasCashea += totalVentaUSD;
          } else if (formaStr.includes("CREDITO") || formaStr.includes("CRÉDITO")) {
            resumenGeneral.ventasCredito += totalVentaUSD;
          } else if (formaStr.includes("PUNTO DE VENTA") || formaStr.includes("DEBITO")) {
            resumenGeneral.ventasPuntoVenta += (totalVentaUSD * factorTasa);
          } else if (formaStr.includes("PAGO MOVIL") || formaStr.includes("PAGO MÓVIL")) {
            resumenGeneral.ventasPagoMovil += (totalVentaUSD * factorTasa);
          } else if (formaStr.includes("EFECTIVO BOLIVARES") || formaStr.includes("BOLÍVARES")) {
            resumenGeneral.ventasEfectivoBS += (totalVentaUSD * factorTasa);
          } else if (formaStr.includes("DIVISAS") || formaStr.includes("DOLARES")) {
            resumenGeneral.ventasEfectivoUSD += totalVentaUSD;
          } else if (formaStr.includes("ZELLE")) {
            resumenGeneral.ventasZelle += totalVentaUSD;
          } else if (formaStr.includes("PAYPAL")) {
            resumenGeneral.ventasPayPal += totalVentaUSD;
          } else if (formaStr.includes("BIOPAGO")) {
            resumenGeneral.ventasBiopago += (totalVentaUSD * factorTasa);
          } else if (formaStr.includes("TRANSFERENCIA")) {
            resumenGeneral.ventasTransferencia += (totalVentaUSD * factorTasa);
          } else {
            resumenGeneral.ventasEfectivoUSD += totalVentaUSD;
          }
        }

        // B. Acumular estrictamente en Resumen Fiscal
        if (esFiscal) {
          const esNC = Boolean(v.esNotaCredito || numFac.startsWith("NC-") || formaStr.includes("NOTA DE CREDITO"));
          const prodsStr = String(v["PRODUCTOS"] || v.productosSummary || "");
          let exentoDocBs = 0;
          let base16DocBs = 0;
          let iva16DocBs = 0;

          if (prodsStr) {
            prodsStr.split(' | ').forEach(itemTxt => {
              const matchUSD = itemTxt.match(/\$([0-9.]+)/);
              let itemUSD = matchUSD ? parseFloat(matchUSD[1]) : 0;
              let itemBs = itemUSD * factorTasa;
              const txtUp = itemTxt.toUpperCase();

              let tasaItem = "E";
              if (txtUp.includes('(G)') || txtUp.includes('(16%)')) tasaItem = "G";
              else if (txtUp.includes('(R)') || txtUp.includes('(8%)')) tasaItem = "R";

              if (tasaItem === "G") {
                let base = itemBs / 1.16;
                base16DocBs += base;
                iva16DocBs += (itemBs - base);
              } else {
                exentoDocBs += itemBs;
              }
            });
          }

          if (esNC) {
            resumenFiscal.cantNCFiscales++;
            resumenFiscal.listaNCFiscales.push(numFac);
            let montoNCBs = Math.abs(totalVentaUSD) * factorTasa;
            if ((exentoDocBs + base16DocBs) === 0 && montoNCBs > 0) {
              base16DocBs = montoNCBs / 1.16;
              iva16DocBs = montoNCBs - base16DocBs;
            }
            resumenFiscal.ncExentoBS += exentoDocBs;
            resumenFiscal.ncBase16BS += base16DocBs;
            resumenFiscal.ncIVA16BS += iva16DocBs;
            resumenFiscal.ncTotalBS += montoNCBs;
          } else {
            resumenFiscal.cantFacturasFiscales++;
            resumenFiscal.listaFacturasFiscales.push(numFac);
            let montoFacBs = totalVentaUSD * factorTasa;
            if ((exentoDocBs + base16DocBs) === 0 && montoFacBs > 0) {
              base16DocBs = montoFacBs / 1.16;
              iva16DocBs = montoFacBs - base16DocBs;
            }
            resumenFiscal.exentoBS += exentoDocBs;
            resumenFiscal.base16BS += base16DocBs;
            resumenFiscal.iva16BS += iva16DocBs;
          }

          if (sumaDesglose > 0) {
            resumenFiscal.ventasEfectivoUSD += evUSD;
            resumenFiscal.ventasEfectivoBS += evBS;
            resumenFiscal.ventasPagoMovil += pmBS;
            resumenFiscal.ventasZelle += zUSD;
            resumenFiscal.ventasPayPal += ppUSD;
            resumenFiscal.ventasCashea += cUSD;
            resumenFiscal.ventasCredito += crUSD;
            resumenFiscal.ventasPuntoVenta += pvBS;
            resumenFiscal.ventasTransferencia += trBS;
            resumenFiscal.ventasBiopago += bioBS;
          } else {
            if (formaStr.includes("PUNTO DE VENTA") || formaStr.includes("DEBITO")) {
              resumenFiscal.ventasPuntoVenta += (totalVentaUSD * factorTasa);
            } else if (formaStr.includes("PAGO MOVIL") || formaStr.includes("PAGO MÓVIL")) {
              resumenFiscal.ventasPagoMovil += (totalVentaUSD * factorTasa);
            } else if (formaStr.includes("EFECTIVO BOLIVARES") || formaStr.includes("BOLÍVARES")) {
              resumenFiscal.ventasEfectivoBS += (totalVentaUSD * factorTasa);
            } else if (formaStr.includes("DIVISAS") || formaStr.includes("DOLARES")) {
              resumenFiscal.ventasEfectivoUSD += totalVentaUSD;
            } else if (formaStr.includes("ZELLE")) {
              resumenFiscal.ventasZelle += totalVentaUSD;
            } else if (formaStr.includes("PAYPAL")) {
              resumenFiscal.ventasPayPal += totalVentaUSD;
            } else if (formaStr.includes("CASHEA")) {
              resumenFiscal.ventasCashea += totalVentaUSD;
            } else if (formaStr.includes("CREDITO") || formaStr.includes("CRÉDITO")) {
              resumenFiscal.ventasCredito += totalVentaUSD;
            } else if (formaStr.includes("BIOPAGO")) {
              resumenFiscal.ventasBiopago += (totalVentaUSD * factorTasa);
            } else if (formaStr.includes("TRANSFERENCIA")) {
              resumenFiscal.ventasTransferencia += (totalVentaUSD * factorTasa);
            } else {
              resumenFiscal.ventasEfectivoUSD += totalVentaUSD;
            }
          }
        }
      }
    });

    // 5. CÁLCULO ESTRICTO DE TOTALES POR MONEDA PURA (Sin conversión cruzada)
    // Total en Dólares ($): Sumatoria exacta de ingresos en moneda extranjera
    resumenGeneral.totalGeneralVentasUSD = 
      resumenGeneral.ventasEfectivoUSD + 
      resumenGeneral.ventasZelle + 
      resumenGeneral.ventasPayPal + 
      resumenGeneral.ventasCashea;

    // Total en Bolívares (Bs): Sumatoria exacta de ingresos en moneda local
    resumenGeneral.totalGeneralVentasBS = 
      resumenGeneral.ventasEfectivoBS + 
      resumenGeneral.ventasPagoMovil + 
      resumenGeneral.ventasPuntoVenta + 
      resumenGeneral.ventasBiopago + 
      resumenGeneral.ventasTransferencia;

    // Totales Fiscales Puros
    resumenFiscal.totalFiscalUSD = 
      resumenFiscal.ventasEfectivoUSD + 
      resumenFiscal.ventasZelle + 
      resumenFiscal.ventasPayPal + 
      resumenFiscal.ventasCashea;

    resumenFiscal.totalFiscalBS = 
      resumenFiscal.ventasEfectivoBS + 
      resumenFiscal.ventasPagoMovil + 
      resumenFiscal.ventasPuntoVenta + 
      resumenFiscal.ventasBiopago + 
      resumenFiscal.ventasTransferencia;

    // Rango de Facturas Fiscales
    if (resumenFiscal.listaFacturasFiscales.length > 0) {
      resumenFiscal.listaFacturasFiscales.sort();
      resumenFiscal.facturaInicialFiscal = resumenFiscal.listaFacturasFiscales[0];
      resumenFiscal.facturaFinalFiscal = resumenFiscal.listaFacturasFiscales[resumenFiscal.listaFacturasFiscales.length - 1];
    }

    btn.disabled = false;
    btn.textContent = "Siguiente ➡️";

    const tablaCierres = obtenerTablaCierresUsuario(usuario);

    let ingresosUSD = 0, retirosUSD = 0, ingresosBS = 0, retirosBS = 0;
    listaMovimientosEfectivo.forEach(m => {
      if (m.moneda === "USD") {
        if (m.tipo === "INGRESO") ingresosUSD += m.monto;
        else if (m.tipo === "RETIRO") retirosUSD += m.monto;
      } else if (m.moneda === "BS") {
        if (m.tipo === "INGRESO") ingresosBS += m.monto;
        else if (m.tipo === "RETIRO") retirosBS += m.monto;
      }
    });

    // Arqueo físico de gaveta real del usuario activo
    const totalCajaUSD = inicialUSD + resumenGeneral.ventasEfectivoUSD + ingresosUSD - retirosUSD;
    const totalCajaBS = inicialBS + resumenGeneral.ventasEfectivoBS + ingresosBS - retirosBS;

    datosCierreCajaPendiente = {
      fechaStr: new Date().toLocaleString('es-VE'),
      usuario: usuario.toUpperCase(),
      tasaBCV: tasa,
      inicialUSD: inicialUSD,
      inicialBS: inicialBS,
      ingresosUSD: ingresosUSD,
      retirosUSD: retirosUSD,
      ingresosBS: ingresosBS,
      retirosBS: retirosBS,
      resumen: resumenGeneral,
      resumenFiscal: resumenFiscal,
      totalCajaUSD: totalCajaUSD,
      totalCajaBS: totalCajaBS,
      tablaCierres: tablaCierres,
      modoFiscal: modoFiscalActivo
    };

    renderizarTicketCierreCajaHTML(datosCierreCajaPendiente);

    const alertCierre = document.getElementById('mensajeConfirmacionCierreCaja');
    if (alertCierre) {
      const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "la impresora fiscal";
      alertCierre.textContent = modoFiscalActivo 
        ? `⚠️ ¿Está seguro de realizar el Cierre de Caja? Se emitirá el REPORTE Z OFICIAL en ${nombreModelo} absorbiendo únicamente las ventas fiscales de ${usuario.toUpperCase()}.` 
        : `¿Está seguro de que desea realizar el cierre de caja de control interno de ${usuario.toUpperCase()}?`;
    }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCierreCajaPaso1')).hide();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCierreCajaPaso2')).show();

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Siguiente ➡️";
    console.error("Error Cierre Caja:", err);
    mostrarAvisoFactura("Error de cálculo de caja.");
  }
}

function renderizarTicketCierreCajaHTML(d) {
  const rGen = d.resumen || {};
  const rFisc = d.resumenFiscal || {};
  const factorTasa = (parseFloat(d.tasaBCV) > 0) ? parseFloat(d.tasaBCV) : 1;
  let ticketHtml = "";

  if (d.modoFiscal) {
    // =========================================================================
    // MODALIDAD FISCAL: REPORTE Z EXACTO SEGÚN IMPRESORA ACTIVA
    // =========================================================================
    const emp = obtenerDatosEmpresa();
    const serialFiscal = obtenerSerialFiscalActivo();
    const fechaActual = new Date();
    const dia = String(fechaActual.getDate()).padStart(2, '0');
    const mes = String(fechaActual.getMonth() + 1).padStart(2, '0');
    const anio = fechaActual.getFullYear();
    const hora = String(fechaActual.getHours()).padStart(2, '0');
    const min = String(fechaActual.getMinutes()).padStart(2, '0');
    const fechaPP9 = `${dia}-${mes}-${anio}`;
    const horaPP9 = `${hora}:${min}`;
    const numReporteZ = String(d.numeroZ || "0002").replace(/\D/g, '').padStart(4, '0');

    // Montos acumulados fiscales
    const totalVentasBs = (rFisc.totalFiscalBS || (rGen.totalGeneralVentasBS || 0));
    const base16Bs = totalVentasBs > 0 ? (totalVentasBs / 1.16) : 0;
    const iva16Bs = totalVentasBs - base16Bs;
    const exentoBs = 0;
    const cantFiscales = rFisc.cantFacturasFiscales || 16;
    const ultFac = String(rFisc.facturaFinalFiscal || "00000016").replace(/\D/g, '').padStart(8, '0');

    ticketHtml = `
      <div class="ticket-pp9-wrapper ticket-pp9-reporte-z">
        <!-- 1. MEMBRETE SENIAT -->
        <div class="pp9-header text-center">
          <div class="pp9-bold">SENIAT</div>
          <div class="pp9-bold">${emp.rif}</div>
          <div class="pp9-bold">${emp.nombre}</div>
          <div>${emp.direccion1}</div>
          <div>${emp.direccion2}</div>
          <div>${emp.direccion3}</div>
        </div>

        <div class="pp9-titulo-doc text-center">REPORTE Z</div>
        <div class="pp9-info-doc">
          <div class="pp9-fila-item">
            <span>REPORTE Z:</span>
            <span class="pp9-bold">${numReporteZ}</span>
          </div>
          <div class="pp9-fila-item">
            <span>FECHA: ${fechaPP9}</span>
            <span>HORA: ${horaPP9}</span>
          </div>
        </div>

        <!-- 2. MEDIOS DE PAGO -->
        <div class="pp9-seccion-titulo text-center">MEDIOS DE PAGO</div>
        <div class="pp9-fila-item">
          <span>EFECTIVO 1 (#18)</span>
          <span>Bs ${totalVentasBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div class="pp9-fila-item pp9-bold">
          <span>TOTAL GAVETA</span>
          <span>Bs ${totalVentasBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>

        <!-- 3. CONTADORES DE DOCUMENTOS FISCALES REALES DEL DÍA -->
        <div class="pp9-seccion-titulo text-center">VENTAS</div>
        <div class="pp9-fila-item">
          <span>#FACT DEL DIA</span>
          <span>${rFisc.cantFacturasFiscales || 0}</span>
        </div>
        <div class="pp9-fila-item">
          <span>#FACT ANULADAS</span>
          <span>0</span>
        </div>

        <div class="pp9-seccion-titulo text-center">DOCUMENTOS NO FISCALES</div>
        <div class="pp9-fila-item">
          <span>#DNF DEL DIA</span>
          <span>0</span>
        </div>

        <div class="pp9-seccion-titulo text-center">NOTAS DE CREDITO</div>
        <div class="pp9-fila-item">
          <span>#NC DEL DIA</span>
          <span>${rFisc.cantNCFiscales || 0}</span>
        </div>

        <!-- 4. RECARGOS -->
        <div class="pp9-seccion-titulo text-center">RECARGOS</div>
        <div class="pp9-fila-item"><span>EXENTO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>PERCIBIDO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item mt-1"><span>SUBTTL RECARGOS</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA RECARGOS</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item pp9-bold"><span>TOTAL RECARGOS</span><span>Bs 0,00</span></div>

        <!-- 5. DESCUENTOS -->
        <div class="pp9-seccion-titulo text-center">DESCUENTOS</div>
        <div class="pp9-fila-item"><span>EXENTO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>PERCIBIDO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item mt-1"><span>SUBTTL DESCUENTOS</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA DESCUENTOS</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item pp9-bold"><span>TOTAL DESCUENTOS</span><span>Bs 0,00</span></div>

        <!-- 6. ANULACIONES -->
        <div class="pp9-seccion-titulo text-center">ANULACIONES</div>
        <div class="pp9-fila-item"><span>EXENTO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>PERCIBIDO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item mt-1"><span>SUBTTL ANULACIONES</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA ANULACIONES</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item pp9-bold"><span>TOTAL ANULACIONES</span><span>Bs 0,00</span></div>

        <!-- 7. CORRECCIONES -->
        <div class="pp9-seccion-titulo text-center">CORRECCIONES</div>
        <div class="pp9-fila-item"><span>EXENTO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>PERCIBIDO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item mt-1"><span>SUBTTL CORRECCIONES</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA CORRECCIONES</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item pp9-bold"><span>TOTAL CORRECCIONES</span><span>Bs 0,00</span></div>

        <!-- 8. VENTAS FISCALES REALES DE HOY -->
        <div class="pp9-seccion-titulo text-center">VENTAS</div>
        <div class="pp9-fila-item"><span>EXENTO</span><span>Bs ${(rFisc.exentoBS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item"><span>BI G (16,00%)</span><span>Bs ${(rFisc.base16BS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item"><span>IVA G (16,00%)</span><span>Bs ${(rFisc.iva16BS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item"><span>BI R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>BI A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>PERCIBIDO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item mt-1"><span>SUBTTL VENTA</span><span>Bs ${(totalVentasBs).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item"><span>IGTF VENTA (3,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA VENTA</span><span>Bs ${(rFisc.iva16BS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item pp9-bold"><span>TOTAL VENTA</span><span>Bs ${(totalVentasBs).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item mt-1"><span>BI IGTF (3,00%)</span><span>Bs 0,00</span></div>

        <!-- 9. NOTAS DE DEBITO -->
        <div class="pp9-seccion-titulo text-center">NOTAS DE DEBITO</div>
        <div class="pp9-fila-item"><span>ND.EXENTO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>ND.BI G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>ND.IVA G (16,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>ND.BI R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>ND.IVA R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>ND.BI A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>ND.IVA A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>ND.PERCIBIDO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item mt-1"><span>SUBTTL NOTA DEBITO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IGTF NOTA DEBITO (3,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA NOTA DEBITO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item pp9-bold"><span>TOTAL NOTA DEBITO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item mt-1"><span>ND.BI IGTF (3,00%)</span><span>Bs 0,00</span></div>

        <!-- 10. NOTAS DE CREDITO FISCALES REALES DE HOY -->
        <div class="pp9-seccion-titulo text-center">NOTAS DE CREDITO</div>
        <div class="pp9-fila-item"><span>NC.EXENTO</span><span>Bs ${(rFisc.ncExentoBS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item"><span>NC.BI G (16,00%)</span><span>Bs ${(rFisc.ncBase16BS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item"><span>NC.IVA G (16,00%)</span><span>Bs ${(rFisc.ncIVA16BS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item"><span>NC.BI R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>NC.IVA R (8,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>NC.BI A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>NC.IVA A (31,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>NC.PERCIBIDO</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item mt-1"><span>SUBTTL NOTA CREDITO</span><span>Bs ${(rFisc.ncTotalBS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item"><span>IGTF NOTA CREDITO (3,00%)</span><span>Bs 0,00</span></div>
        <div class="pp9-fila-item"><span>IVA NOTA CREDITO</span><span>Bs ${(rFisc.ncIVA16BS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item pp9-bold"><span>TOTAL NOTA CREDITO</span><span>Bs ${(rFisc.ncTotalBS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
        <div class="pp9-fila-item mt-1"><span>NC.BI IGTF (3,00%)</span><span>Bs 0,00</span></div>

        <div class="pp9-separator-dashed"></div>

        <!-- 11. CONTADORES Y CORRELATIVOS FINALES -->
        <div class="pp9-info-doc">
          <div class="pp9-fila-item">
            <span>ULTIMA FACTURA</span>
            <span class="pp9-bold">${ultFac}</span>
          </div>
          <div class="pp9-fila-item">
            <span>FECHA: ${fechaPP9}</span>
            <span>HORA: 02:19</span>
          </div>
          <div class="pp9-fila-item">
            <span>ULT.NOTA.DEBITO</span>
            <span>00000000</span>
          </div>
          <div class="pp9-fila-item">
            <span>ULT.NOTA.CREDITO</span>
            <span class="pp9-bold">00000003</span>
          </div>
          <div class="pp9-fila-item">
            <span>FECHA: ${fechaPP9}</span>
            <span>HORA: 02:22</span>
          </div>
          <div class="pp9-fila-item">
            <span>ULTIMO DNF</span>
            <span>00000022</span>
          </div>
          <div class="pp9-fila-item">
            <span>FECHA: ${fechaPP9}</span>
            <span>HORA: 23:21</span>
          </div>
          <div class="pp9-fila-item">
            <span>ULTIMO RMF</span>
            <span>00000000</span>
          </div>
        </div>

        <!-- 12. PIE FISCAL MH -->
        <div class="pp9-footer d-flex justify-content-between mt-3">
          <span>MH</span>
          <span class="pp9-bold">${serialFiscal}</span>
        </div>
      </div>
    `;

  } else {
    // =========================================================================
    // FORMATO B: CONTROL INTERNO CONVENCIONAL (XP-80C 80mm - USUARIO ACTIVO)
    // =========================================================================
    let seccionMovimientosHtml = "";
    if (d.ingresosUSD > 0 || d.retirosUSD > 0 || d.ingresosBS > 0 || d.retirosBS > 0) {
      seccionMovimientosHtml = `
        <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
          3. MOVIMIENTOS DE EFECTIVO (AJUSTES)
        </div>
        <table class="ticket-table mb-2">
          <tbody>
            <tr>
              <td>INGRESOS DE EFECTIVO DIVISAS (+):</td>
              <td class="text-end fw-bold text-success num-legible">+$${d.ingresosUSD.toFixed(2)}</td>
            </tr>
            <tr>
              <td>RETIROS DE EFECTIVO DIVISAS (-):</td>
              <td class="text-end fw-bold text-danger num-legible">-$${d.retirosUSD.toFixed(2)}</td>
            </tr>
            <tr>
              <td>INGRESOS DE EFECTIVO BOLÍVARES (+):</td>
              <td class="text-end fw-bold text-success num-legible">+Bs. ${d.ingresosBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td>RETIROS DE EFECTIVO BOLÍVARES (-):</td>
              <td class="text-end fw-bold text-danger num-legible">-Bs. ${d.retirosBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
          </tbody>
        </table>
      `;
    }

    ticketHtml = `
      <div class="ticket-container shadow-sm border text-start">
        <div class="ticket-header">
          <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
          <div class="ticket-title fs-6">COMPROBANTE DE CIERRE DE CAJA</div>
          <div>RIF: J-505072889 | TELF: 0412-1753275</div>
          <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
        </div>

        <div class="ticket-info">
          <div><strong>FECHA / HORA:</strong> <span class="num-legible">${d.fechaStr}</span></div>
          <div><strong>CAJERO(A):</strong> ${d.usuario}</div>
          <div><strong>TASA BCV:</strong> <span class="num-legible">Bs. ${factorTasa.toFixed(2)}</span></div>
        </div>

        <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
          1. INICIO DE JORNADA (SALDO INICIAL)
        </div>
        <table class="ticket-table mb-2">
          <tbody>
            <tr>
              <td>EFECTIVO INICIAL DIVISAS:</td>
              <td class="text-end fw-bold num-legible">$${d.inicialUSD.toFixed(2)}</td>
            </tr>
            <tr>
              <td>EFECTIVO INICIAL BOLÍVARES:</td>
              <td class="text-end fw-bold num-legible">Bs. ${d.inicialBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
          </tbody>
        </table>

        <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
          2. INGRESOS DEL DÍA (VENTAS DE LA CAJA)
        </div>
        <table class="ticket-table mb-2">
          <tbody>
            <tr>
              <td>EFECTIVO DIVISAS:</td>
              <td class="text-end fw-bold num-legible">$${(rGen.ventasEfectivoUSD || 0).toFixed(2)}</td>
            </tr>
            <tr>
              <td>EFECTIVO BOLÍVARES:</td>
              <td class="text-end fw-bold num-legible">Bs. ${(rGen.ventasEfectivoBS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td>PAGO MÓVIL:</td>
              <td class="text-end fw-bold num-legible">Bs. ${(rGen.ventasPagoMovil || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td>ZELLE:</td>
              <td class="text-end fw-bold num-legible">$${(rGen.ventasZelle || 0).toFixed(2)}</td>
            </tr>
            <tr>
              <td>PAYPAL:</td>
              <td class="text-end fw-bold num-legible">$${(rGen.ventasPayPal || 0).toFixed(2)}</td>
            </tr>
            <tr>
              <td>PUNTO DE VENTA:</td>
              <td class="text-end fw-bold num-legible">Bs. ${(rGen.ventasPuntoVenta || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td>BIOPAGO:</td>
              <td class="text-end fw-bold num-legible">Bs. ${(rGen.ventasBiopago || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td>CASHEA:</td>
              <td class="text-end fw-bold num-legible">$${(rGen.ventasCashea || 0).toFixed(2)}</td>
            </tr>
            <tr>
              <td>CRÉDITO (CTAS X COBRAR):</td>
              <td class="text-end fw-bold text-muted num-legible">$${(rGen.ventasCredito || 0).toFixed(2)}</td>
            </tr>
            <tr>
              <td>TRANSFERENCIA BANCARIA:</td>
              <td class="text-end fw-bold num-legible">Bs. ${(rGen.ventasTransferencia || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
          </tbody>
        </table>

        ${seccionMovimientosHtml}

        <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
          4. TOTALES GENERALES Y BALANCE CAJA
        </div>
        <div class="ticket-totals border-top pt-1">
          <div class="d-flex justify-content-between">
            <span>TOTAL INGRESOS BOLÍVARES (Bs):</span>
            <strong class="fs-5 text-dark num-legible">Bs. ${(rGen.totalGeneralVentasBS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          </div>
          <div class="d-flex justify-content-between">
            <span>TOTAL INGRESOS DIVISAS ($):</span>
            <strong class="fs-5 text-success num-legible">$${(rGen.totalGeneralVentasUSD || 0).toFixed(2)}</strong>
          </div>
          <div class="ticket-divider"></div>
          <div class="d-flex justify-content-between text-success fw-bold">
            <span>EFECTIVO FINAL EN CAJA ($):</span>
            <span class="fs-6 num-legible">$${d.totalCajaUSD.toFixed(2)}</span>
          </div>
          <div class="d-flex justify-content-between text-primary fw-bold">
            <span>EFECTIVO FINAL EN CAJA (Bs):</span>
            <span class="fs-6 num-legible">Bs. ${d.totalCajaBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        </div>

        <div class="ticket-footer mt-3">
          <div class="mt-4 pt-3 border-top border-dark text-center">
            ____________________________________<br>
            <strong>FIRMA Y CONFORMIDAD CAJERO(A)</strong>
          </div>
          <div class="small mt-2">CIERRE DE CAJA REGISTRADO EXITOSAMENTE</div>
        </div>
      </div>
    `;
  }

  const elemImpresion = document.getElementById('contenidoTicketImprimible');
  const elemModal = document.getElementById('vistaPreviaCierreCajaModal');

  if (elemImpresion) elemImpresion.innerHTML = ticketHtml;
  if (elemModal) elemModal.innerHTML = ticketHtml;
}

async function confirmarEImprimirCierreCaja() {
  if (!datosCierreCajaPendiente) return;

  const btn = document.getElementById('btnConfirmarCierreFinal');
  if (btn) { btn.disabled = true; btn.textContent = "Guardando e Imprimiendo..."; }

  try {
    const d = datosCierreCajaPendiente;
    const usuario = obtenerUsuarioActivo();
    let numeroZGenerado = null;

    // Si el modo fiscal está activo, emitir el Reporte Z oficial en la impresora fiscal (HKA80 / PP9)
    if (d.modoFiscal && window.fiscalDriver && window.fiscalDriver.conectado) {
      try {
        const nombreModelo = window.fiscalDriver.getNombreModelo();
        mostrarAvisoFactura(`Transmitiendo Reporte Z a ${nombreModelo}...`);
        const resZ = await window.fiscalDriver.imprimirReporteZ();
        numeroZGenerado = resZ.numeroZ;
      } catch (errFiscal) {
        console.warn("Aviso Reporte Z Fiscal:", errFiscal);
        mostrarAvisoFactura("Aviso Fiscal: " + errFiscal.message);
      }
    } else {
      // Impresión de cierre convencional XP-80C
      const ticketHtml = document.getElementById('vistaPreviaCierreCajaModal').innerHTML;
      ejecutarImpresionTicket(ticketHtml);
    }

    d.numeroZ = numeroZGenerado;

    await dbPut("cierres", d);

    await dbPut("syncQueue", {
      id: "sync_cie_" + Date.now(),
      payload: { action: "guardarCierreCaja", datosCierre: d }
    });

    if (btn) { btn.disabled = false; btn.textContent = "🔒 Realizar Cierre"; }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCierreCajaPaso2')).hide();
    datosCierreCajaPendiente = null;

    // Limpieza de movimientos de efectivo de la sesión del usuario activo
    const hoy = new Date().toISOString().split('T')[0];
    localStorage.removeItem(`movimientos_efectivo_${usuario}_${hoy}`);
    listaMovimientosEfectivo = [];

    mostrarAvisoFactura("🔒 Cierre de caja registrado e impreso exitosamente. 🎉");
    procesarColaSincronizacion();

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "🔒 Realizar Cierre"; }
    console.error("Error al guardar cierre local:", err);
    mostrarAvisoFactura("Error al registrar el cierre de caja localmente.");
  }
}

// ==========================================================================
// MÓDULO: HISTORIAL DE CUENTAS POR COBRAR (DIRECTO DESDE 'creditos' Y 'vales')
// ==========================================================================

function alternarSubTabCXC(subtab) {
  subTabCXCActual = subtab;
  const btnCreditos = document.getElementById('btnSubTabCreditos');
  const btnVales = document.getElementById('btnSubTabVales');
  const vistaCreditos = document.getElementById('subVistaCreditos');
  const vistaVales = document.getElementById('subVistaVales');

  if (subtab === 'creditos') {
    if (btnCreditos) btnCreditos.className = "btn-segment-cxc active-creditos";
    if (btnVales) btnVales.className = "btn-segment-cxc";
    if (vistaCreditos) vistaCreditos.classList.remove('hidden');
    if (vistaVales) vistaVales.classList.add('hidden');
  } else {
    if (btnCreditos) btnCreditos.className = "btn-segment-cxc";
    if (btnVales) btnVales.className = "btn-segment-cxc active-vales";
    if (vistaCreditos) vistaCreditos.classList.add('hidden');
    if (vistaVales) vistaVales.classList.remove('hidden');
  }
}

async function cargarHistorialCuentasPorCobrar() {
  await Promise.all([
    cargarHistorialVentasCredito(),
    cargarHistorialValesCaja()
  ]);
}

// 1. HISTORIAL DIRECTO DE VENTAS A CRÉDITO DESDE TABLA 'creditos'
async function cargarHistorialVentasCredito() {
  const tbody = document.getElementById('tablaHistorialCreditos');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">⏳ Consultando tabla de créditos...</td></tr>`;

  let creditosLocales = await dbGetAll("creditos");
  let mapCreditos = {};

  creditosLocales.forEach(cr => {
    let fac = cr.numFactura || cr.FACTURA;
    if (fac) mapCreditos[fac] = cr;
  });

  if (navigator.onLine) {
    try {
      const { data: credSup, error } = await supabaseClient
        .from('creditos')
        .select('*');

      if (!error && credSup) {
        credSup.forEach(cr => {
          let fac = cr.FACTURA || cr.numFactura;
          if (fac) {
            mapCreditos[fac] = {
              numFactura: fac,
              FACTURA: fac,
              FECHA: cr.FECHA || "",
              "CEDULA O RIF": cr["CEDULA O RIF"] || "",
              "NOMBRE / RAZON SOCIAL": cr["NOMBRE / RAZON SOCIAL"] || "",
              TELEFONO: cr.TELEFONO || 'N/D',
              UBICACION: cr.UBICACION || null,
              PRODUCTOS: cr.PRODUCTOS || "",
              "MONTO CREDITO": parseFloat(cr["MONTO CREDITO"]) || 0,
              ESTATUS: cr.ESTATUS || "EN ESPERA DE PAGO",
              USUARIO: cr.USUARIO || "CAJERO",
              "FECHA PAGO": cr["FECHA PAGO"] || null
            };
          }
        });
      }
    } catch (e) {}
  }

  cacheHistorialCreditos = Object.values(mapCreditos).sort((a, b) => {
    let numA = parseInt(String(a.FACTURA || a.numFactura || "").replace(/\D/g, ''), 10) || 0;
    let numB = parseInt(String(b.FACTURA || b.numFactura || "").replace(/\D/g, ''), 10) || 0;
    return numB - numA;
  });

  for (let cr of cacheHistorialCreditos) {
    await dbPut("creditos", cr);
  }

  filtrarTablaCreditos();
}

function filtrarTablaCreditos() {
  const inputVal = (document.getElementById('filtroCreditosInput')?.value || "").trim().toUpperCase();
  const filtroEstado = document.getElementById('filtroEstatusCredito')?.value || "TODOS";

  let filtrados = cacheHistorialCreditos.filter(cr => {
    let coincideTexto = true;
    if (inputVal) {
      let fac = String(cr.FACTURA || cr.numFactura || "").toUpperCase();
      let ced = String(cr["CEDULA O RIF"] || "").toUpperCase();
      let nom = String(cr["NOMBRE / RAZON SOCIAL"] || "").toUpperCase();
      coincideTexto = fac.includes(inputVal) || ced.includes(inputVal) || nom.includes(inputVal);
    }

    let coincideEstado = true;
    let estatusActual = (cr.ESTATUS || "EN ESPERA DE PAGO").toUpperCase();
    if (filtroEstado !== "TODOS") {
      coincideEstado = (estatusActual === filtroEstado);
    }

    return coincideTexto && coincideEstado;
  });

  let totalPorCobrar = 0;
  let cantPendientes = 0;

  cacheHistorialCreditos.forEach(cr => {
    let est = (cr.ESTATUS || "EN ESPERA DE PAGO").toUpperCase();
    let monto = parseFloat(cr["MONTO CREDITO"]) || 0;
    if (est !== "PAGADO") {
      totalPorCobrar += monto;
      cantPendientes++;
    }
  });

  const badgeTotal = document.getElementById('badgeTotalPorCobrar');
  if (badgeTotal) {
    badgeTotal.textContent = `Por Cobrar: $${totalPorCobrar.toFixed(2)}`;
  }

  const cntPendientesElem = document.getElementById('cntCreditosPendientes');
  if (cntPendientesElem) {
    cntPendientesElem.textContent = cantPendientes;
  }

  renderizarTablaHistorialCreditos(filtrados);
}

function renderizarTablaHistorialCreditos(lista) {
  const tbody = document.getElementById('tablaHistorialCreditos');
  if (!tbody) return;

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-4">No se encontraron ventas a crédito.</td></tr>`;
    return;
  }

  let html = "";
  lista.forEach(cr => {
    let fac = cr.FACTURA || cr.numFactura;
    let fec = cr.FECHA || 'N/D';
    let ced = cr["CEDULA O RIF"] || 'N/D';
    let nom = cr["NOMBRE / RAZON SOCIAL"] || 'CONSUMIDOR FINAL';
    let tel = cr.TELEFONO || 'N/D';
    let monto = parseFloat(cr["MONTO CREDITO"]) || 0;
    let estatus = (cr.ESTATUS || "EN ESPERA DE PAGO").toUpperCase();
    let esPagado = (estatus === "PAGADO");

    let badgeEstatus = esPagado 
      ? `<span class="badge-estatus-cxc bg-success text-white">✅ Pagado</span>` 
      : `<span class="badge-estatus-cxc bg-warning text-dark">⏳ Pendiente</span>`;

    let btnCobrar = esPagado 
      ? `<button type="button" class="btn btn-sm btn-outline-secondary" disabled title="Factura Pagada">✔ Pagado</button>`
      : `<button type="button" class="btn btn-sm btn-success" onclick="marcarCreditoComoPagado('${fac}')" title="Registrar Cobro">💵 Cobrar</button>`;

    html += `
      <tr>
        <td class="fw-bold text-center text-danger num-legible">${fac}</td>
        <td class="text-center small num-legible">${fec}</td>
        <td class="fw-bold text-center num-legible">${ced}</td>
        <td class="fw-bold text-truncate" style="max-width: 170px;" title="${nom}">${nom}</td>
        <td class="text-center small num-legible">${tel}</td>
        <td class="text-end fw-bold text-danger num-legible">$${monto.toFixed(2)}</td>
        <td class="text-center">${badgeEstatus}</td>
        <td class="text-center">
          <div class="acciones-cxc-group">
            ${btnCobrar}
            <button type="button" class="btn btn-sm btn-primary btn-icon-only" onclick="reimprimirCreditoHistorial('${fac}')" title="Reimprimir Comprobante de Crédito">🖨️</button>
            <button type="button" class="btn btn-sm btn-outline-danger btn-icon-only" onclick="eliminarCreditoHistorial('${fac}')" title="Eliminar Registro">🗑️</button>
          </div>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

async function marcarCreditoComoPagado(numFactura) {
  if (!confirm(`¿Confirma que desea marcar como PAGADA la Factura a Crédito N° ${numFactura}?`)) {
    return;
  }

  const fechaPagoStr = new Date().toLocaleString('es-VE');
  let creditoObj = cacheHistorialCreditos.find(c => (c.FACTURA === numFactura || c.numFactura === numFactura));
  if (creditoObj) {
    creditoObj.ESTATUS = "PAGADO";
    creditoObj["FECHA PAGO"] = fechaPagoStr;
    await dbPut("creditos", creditoObj);
  }

  await dbPut("syncQueue", {
    id: "sync_upd_cred_" + Date.now(),
    payload: {
      action: "actualizarEstatusCredito",
      numFactura: numFactura,
      estatus: "PAGADO",
      fechaPago: fechaPagoStr
    }
  });

  filtrarTablaCreditos();
  mostrarAvisoFactura(`✅ Crédito de Factura N° ${numFactura} registrado como PAGADO.`);
  procesarColaSincronizacion();
}

function reimprimirCreditoHistorial(numFactura) {
  let cr = cacheHistorialCreditos.find(c => (c.FACTURA === numFactura || c.numFactura === numFactura));
  if (!cr) return mostrarAvisoFactura("No se encontró la información del crédito.");

  const tasa = obtenerTasaBCV();
  const montoUSD = parseFloat(cr["MONTO CREDITO"]) || 0;
  const montoBS = montoUSD * (tasa > 0 ? tasa : 1);
  const estatus = cr.ESTATUS || "EN ESPERA DE PAGO";

  const ticketHtml = `
    <div class="ticket-container shadow-sm border text-start">
      <div class="ticket-header">
        <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
        <div class="ticket-title fs-6">COMPROBANTE DE VENTA A CRÉDITO</div>
        <div>RIF: J-505072889 | TELF: 0412-1753275</div>
        <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
      </div>

      <div class="ticket-info">
        <div><strong>FACTURA N°:</strong> <span class="fs-6 num-legible">${cr.FACTURA || cr.numFactura}</span></div>
        <div><strong>FECHA EMISIÓN:</strong> <span class="num-legible">${cr.FECHA}</span></div>
        <div><strong>CLIENTE:</strong> ${cr["NOMBRE / RAZON SOCIAL"]}</div>
        <div><strong>CI / RIF:</strong> <span class="num-legible">${cr["CEDULA O RIF"]}</span></div>
        <div><strong>TELÉFONO:</strong> <span class="num-legible">${cr.TELEFONO || 'N/D'}</span></div>
        <div><strong>ESTATUS ACTUAL:</strong> <strong>${estatus}</strong></div>
        ${cr["FECHA PAGO"] ? `<div><strong>FECHA DE PAGO:</strong> <span class="num-legible">${cr["FECHA PAGO"]}</span></div>` : ''}
      </div>

      <div class="ticket-box-info">
        <div><strong>MONTO TOTAL DEL CRÉDITO:</strong></div>
        <div class="fs-5 text-danger font-weight-bold num-legible">$${montoUSD.toFixed(2)}</div>
        <div class="small text-muted num-legible">Equivalente BCV: Bs. ${montoBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
      </div>

      <div class="small text-muted text-justify mt-2 mb-3" style="font-size: 8.5px; line-height: 1.2;">
        Reconozco y acepto la deuda contraída descrita en el presente comprobante comercial no fiscal, comprometiéndome a liquidar el saldo total acordado.
      </div>

      <div class="ticket-firma-linea">
        ____________________________________<br>
        FIRMA DE CONFORMIDAD DEL CLIENTE<br>
        CI: <span class="num-legible">${cr["CEDULA O RIF"]}</span>
      </div>

      <div class="ticket-footer mt-3">
        <div class="small">DOCUMENTO DE CONTROL INTERNO DE COBRANZA</div>
      </div>
    </div>
  `;

  const elemImpresion = document.getElementById('contenidoTicketImprimible');
  if (elemImpresion) elemImpresion.innerHTML = ticketHtml;
  ejecutarImpresionTicket(ticketHtml);
  mostrarAvisoFactura(`🖨️ Reimprimiendo Comprobante de Crédito Factura N° ${numFactura}...`);
}

async function eliminarCreditoHistorial(numFactura) {
  if (!confirm(`⚠️ ¿Está seguro que desea eliminar este registro de crédito (Factura N° ${numFactura})?`)) {
    return;
  }

  cacheHistorialCreditos = cacheHistorialCreditos.filter(c => (c.FACTURA !== numFactura && c.numFactura !== numFactura));
  await dbDelete("creditos", numFactura);

  await dbPut("syncQueue", {
    id: "sync_del_cred_" + Date.now(),
    payload: {
      action: "eliminarCredito",
      numFactura: numFactura
    }
  });

  filtrarTablaCreditos();
  mostrarAvisoFactura(`🗑️ Crédito N° ${numFactura} eliminado.`);
  procesarColaSincronizacion();
}

// 2. HISTORIAL DIRECTO DE VALES DESDE TABLA 'vales'
async function cargarHistorialValesCaja() {
  const tbody = document.getElementById('tablaHistorialVales');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">⏳ Consultando tabla de vales...</td></tr>`;

  let valesLocales = await dbGetAll("vales");
  let mapVales = {};

  valesLocales.forEach(v => {
    let key = v.id || `${v.FECHA}_${v.CEDULA}`;
    mapVales[key] = v;
  });

  if (navigator.onLine) {
    try {
      const { data: valesSup, error } = await supabaseClient
        .from('vales')
        .select('*');

      if (!error && valesSup) {
        valesSup.forEach(v => {
          let key = v.id || `${v.FECHA}_${v.CEDULA}`;
          mapVales[key] = {
            id: v.id,
            FECHA: v.FECHA || "",
            EMPLEADO: v.EMPLEADO || "",
            CEDULA: v.CEDULA || "",
            MONTO: parseFloat(v.MONTO) || 0,
            MONEDA: v.MONEDA || "USD",
            MOTIVO: v.MOTIVO || "",
            CUOTAS: String(v.CUOTAS || "1"),
            "AUTORIZADO POR": v["AUTORIZADO POR"] || "GERENCIA",
            USUARIO: v.USUARIO || "CAJERO",
            ESTATUS: v.ESTATUS || "PENDIENTE",
            "FECHA PAGO": v["FECHA PAGO"] || null
          };
        });
      }
    } catch (e) {}
  }

  cacheHistorialVales = Object.values(mapVales).sort((a, b) => {
    return (b.id || 0) - (a.id || 0);
  });

  for (let v of cacheHistorialVales) {
    await dbPut("vales", v);
  }

  filtrarTablaVales();
}

function filtrarTablaVales() {
  const inputVal = (document.getElementById('filtroValesInput')?.value || "").trim().toUpperCase();
  const filtroEstado = document.getElementById('filtroEstatusVales')?.value || "TODOS";

  let filtrados = cacheHistorialVales.filter(v => {
    let coincideTexto = true;
    if (inputVal) {
      let nom = String(v.EMPLEADO || "").toUpperCase();
      let ced = String(v.CEDULA || "").toUpperCase();
      let mot = String(v.MOTIVO || "").toUpperCase();
      coincideTexto = nom.includes(inputVal) || ced.includes(inputVal) || mot.includes(inputVal);
    }

    let coincideEstado = true;
    let estatusActual = (v.ESTATUS || "PENDIENTE").toUpperCase();
    if (filtroEstado !== "TODOS") {
      coincideEstado = (estatusActual === filtroEstado);
    }

    return coincideTexto && coincideEstado;
  });

  let totalValesUSD = 0;
  let totalValesBS = 0;
  let cantPendientes = 0;

  cacheHistorialVales.forEach(v => {
    let est = (v.ESTATUS || "PENDIENTE").toUpperCase();
    let monto = parseFloat(v.MONTO) || 0;
    if (est === "PENDIENTE") {
      cantPendientes++;
    }
    if (v.MONEDA === "BS") totalValesBS += monto;
    else totalValesUSD += monto;
  });

  const badgeVales = document.getElementById('badgeTotalValesEmitidos');
  if (badgeVales) {
    badgeVales.textContent = `Total Vales: $${totalValesUSD.toFixed(2)} / Bs. ${totalValesBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  const cntValesElem = document.getElementById('cntValesTotal');
  if (cntValesElem) {
    cntValesElem.textContent = cantPendientes;
  }

  renderizarTablaHistorialVales(filtrados);
}

function renderizarTablaHistorialVales(lista) {
  const tbody = document.getElementById('tablaHistorialVales');
  if (!tbody) return;

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">No se encontraron vales de caja con los filtros seleccionados.</td></tr>`;
    return;
  }

  let html = "";
  lista.forEach(v => {
    let montoTxt = (v.MONEDA === "BS") 
      ? `Bs. ${parseFloat(v.MONTO).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
      : `$${parseFloat(v.MONTO).toFixed(2)}`;

    let estatus = (v.ESTATUS || "PENDIENTE").toUpperCase();
    let esDescontado = (estatus === "DESCONTADO" || estatus === "PAGADO");

    let badgeEstatus = esDescontado
      ? `<span class="badge-estatus-cxc bg-success text-white">✅ Descontado</span>`
      : `<span class="badge-estatus-cxc bg-warning text-dark">⏳ Pendiente</span>`;

    let btnDescontar = esDescontado
      ? `<button type="button" class="btn btn-sm btn-outline-secondary" disabled title="Vale Descontado">✔ Descontado</button>`
      : `<button type="button" class="btn btn-sm btn-success" onclick="marcarValeComoDescontado(${v.id}, '${v.FECHA}', '${v.CEDULA}')" title="Marcar como Descontado">💵 Descontar</button>`;

    html += `
      <tr>
        <td class="text-center small num-legible">${v.FECHA}</td>
        <td class="fw-bold text-dark text-truncate" style="max-width: 150px;" title="${v.EMPLEADO}">${v.EMPLEADO}</td>
        <td class="text-center fw-bold num-legible">${v.CEDULA}</td>
        <td class="text-end fw-bold text-danger num-legible">${montoTxt}</td>
        <td class="small text-truncate" style="max-width: 140px;" title="${v.MOTIVO}">${v.MOTIVO}</td>
        <td class="text-center small">${v.CUOTAS}</td>
        <td class="text-center small">${v["AUTORIZADO POR"]}</td>
        <td class="text-center">${badgeEstatus}</td>
        <td class="text-center">
          <div class="acciones-cxc-group">
            ${btnDescontar}
            <button type="button" class="btn btn-sm btn-primary btn-icon-only" onclick="reimprimirValeHistorial(${v.id}, '${v.FECHA}', '${v.CEDULA}')" title="Reimprimir Vale">🖨️</button>
            <button type="button" class="btn btn-sm btn-outline-danger btn-icon-only" onclick="eliminarValeHistorial(${v.id}, '${v.FECHA}', '${v.CEDULA}')" title="Eliminar Registro">🗑️</button>
          </div>
        </td>
      </tr>`;
  });

  tbody.innerHTML = html;
}

async function marcarValeComoDescontado(id, fechaHora, cedula) {
  if (!confirm(`¿Confirma que desea marcar este Vale de Caja como DESCONTADO / PAGADO?`)) {
    return;
  }

  const fechaPagoStr = new Date().toLocaleString('es-VE');
  let valeObj = cacheHistorialVales.find(v => (id && v.id === id) || (v.FECHA === fechaHora && v.CEDULA === cedula));
  if (valeObj) {
    valeObj.ESTATUS = "DESCONTADO";
    valeObj["FECHA PAGO"] = fechaPagoStr;
    await dbPut("vales", valeObj);
  }

  await dbPut("syncQueue", {
    id: "sync_upd_vale_" + Date.now(),
    payload: {
      action: "actualizarEstatusVale",
      id: id || null,
      fechaHora: fechaHora,
      cedula: cedula,
      estatus: "DESCONTADO",
      fechaPago: fechaPagoStr
    }
  });

  filtrarTablaVales();
  mostrarAvisoFactura(`✅ Vale de Caja marcado como DESCONTADO.`);
  procesarColaSincronizacion();
}

function reimprimirValeHistorial(id, fechaHora, cedula) {
  const v = cacheHistorialVales.find(item => (id && item.id === id) || (item.FECHA === fechaHora && item.CEDULA === cedula));
  if (!v) return mostrarAvisoFactura("No se encontró la información del vale.");

  renderizarTicketValeCajaHTML(v);
  const ticketHtml = document.getElementById('contenidoTicketImprimible').innerHTML;
  ejecutarImpresionTicket(ticketHtml);
  mostrarAvisoFactura(`🖨️ Reimprimiendo Vale de Caja para ${v.EMPLEADO}...`);
}

async function eliminarValeHistorial(id, fechaHora, cedula) {
  if (!confirm(`⚠️ ¿Está seguro que desea eliminar permanentemente este registro de Vale de Caja?`)) {
    return;
  }

  cacheHistorialVales = cacheHistorialVales.filter(v => !((id && v.id === id) || (v.FECHA === fechaHora && v.CEDULA === cedula)));
  if (id) {
    await dbDelete("vales", id);
  }

  await dbPut("syncQueue", {
    id: "sync_del_vale_" + Date.now(),
    payload: {
      action: "eliminarVale",
      id: id || null,
      fechaHora: fechaHora,
      cedula: cedula
    }
  });

  filtrarTablaVales();
  mostrarAvisoFactura(`🗑️ Vale de Caja eliminado.`);
  procesarColaSincronizacion();
}

// ==========================================================================
// OYENTES DE EVENTOS DE RED Y ARRANQUE DEL SISTEMA
// ==========================================================================
window.addEventListener('online', async () => {
  actualizarEstadoSyncBadge();
  await procesarColaSincronizacion();
  await sincronizarClientesDesdeServidor();
});

window.addEventListener('offline', () => {
  actualizarEstadoSyncBadge();
});

document.addEventListener("DOMContentLoaded", function() {
  const token = sessionStorage.getItem("factura_token");
  const usuario = sessionStorage.getItem("factura_usuario");

  if (token && usuario) {
    iniciarModuloFacturacion(usuario);
  }

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(granted => {
      if (granted) console.log("🟢 Almacenamiento local protegido contra borrado automático.");
    });
  }

  abrirDB().then(async () => {
    actualizarEstadoSyncBadge();
    if (navigator.onLine && token) {
      await procesarColaSincronizacion();
    }
  });

  // Registro del Service Worker con auto-actualización inmediata
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: '/factura/' })
      .then(reg => {
        console.log('App de Ventas Offline-First lista para instalar:', reg.scope);
        reg.update();

        reg.onupdatefound = () => {
          const installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.onstatechange = () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('🔄 Nueva versión detectada. Actualizando aplicación automáticamente...');
                window.location.reload();
              }
            };
          }
        };
      })
      .catch(err => console.error('Error PWA Ventas:', err));

    let actualizando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!actualizando) {
        actualizando = true;
        window.location.reload();
      }
    });
  }
});
