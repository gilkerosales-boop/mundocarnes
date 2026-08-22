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
function inicializarModoFiscal() {
  const guardado = localStorage.getItem("pos_modo_fiscal");
  modoFiscalActivo = (guardado === "true");

  const chk = document.getElementById('chkModoFiscal');
  if (chk) chk.checked = modoFiscalActivo;

  const modeloGuardado = localStorage.getItem("pos_modelo_impresora_fiscal") || "HKA80";
  const selectModelo = document.getElementById('selectModeloFiscal');
  if (selectModelo) selectModelo.value = modeloGuardado;

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

function cambiarModeloImpresoraFiscal(nuevoModelo) {
  if (window.fiscalDriver) {
    window.fiscalDriver.setModelo(nuevoModelo);
    actualizarInterfazModoFiscal();
    mostrarAvisoFactura(`🖨️ Modelo fiscal configurado: ${window.fiscalDriver.getNombreModelo()}`);
  }
}

function actualizarInterfazModoFiscal() {
  const badgeModo = document.getElementById('badgeModoFiscal');
  const selectModelo = document.getElementById('selectModeloFiscal');
  const btnConectar = document.getElementById('btnConectarFiscal');
  const btnHero = document.getElementById('btnEjecutarFacturarHero');
  const btnModalEmitir = document.getElementById('btnEmitirFacturaFinal');
  const labelTituloCobro = document.getElementById('labelProcesarFactura');
  const btnRepX = document.getElementById('btnReporteXFiscal');

  const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "Fiscal";
  const modeloTag = window.fiscalDriver ? window.fiscalDriver.modelo : "HKA80";

  if (modoFiscalActivo) {
    if (badgeModo) {
      badgeModo.textContent = `🟢 Fiscal`;
      badgeModo.className = "badge-modo-fiscal fiscal-on";
    }
    if (selectModelo) selectModelo.classList.remove('hidden');
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
    if (selectModelo) selectModelo.classList.add('hidden');
    if (btnConectar) btnConectar.classList.add('hidden');
    if (btnRepX) btnRepX.classList.add('hidden');
    if (btnHero) {
      btnHero.textContent = "Facturar 🧾";
      btnHero.className = "btn btn-facturar-hero w-100 mb-2 shadow";
    }
    if (btnModalEmitir) {
      btnModalEmitir.textContent = "🧾 Emitir Factura No Fiscal";
      btnModalEmitir.className = "btn btn-success fw-bold px-5 py-2 fs-5 rounded-pill shadow";
    }
    if (labelTituloCobro) {
      labelTituloCobro.textContent = "🧾 Procesar Recibo de Pago (Control Interno)";
    }
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

  if (estado === "CONECTADO") {
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
// CÁLCULO TRIBUTARIO DINÁMICO DE BASES IMPONIBLES E IVA (EXENTO / 16% / 8%)
// ==========================================================================
function calcularTotalesTributarios(itemsObj) {
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

  const totalIVA = montoIVA16 + montoIVA8;
  const totalBaseGravable = montoBase16 + montoBase8;

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
          "BIOPAGO": parseFloat(desgl["Biopago"]) || 0
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
          "TOTAL 4": parseFloat(d.totalCajaBS) || 0
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

// CORRELATIVO GLOBAL ROBUSTO (COLUMNA 'FACTURA')
async function obtenerSiguienteCorrelativoLocal() {
  let ultimoNum = 0;

  const ventasLocales = await dbGetAll("ventas");
  ventasLocales.forEach(v => {
    if (v.numFactura) {
      let match = String(v.numFactura).match(/\d+$/);
      if (match) {
        let n = parseInt(match[0], 10);
        if (n > ultimoNum) ultimoNum = n;
      }
    }
  });

  const queue = await dbGetAll("syncQueue");
  queue.forEach(item => {
    if (item.payload && item.payload.datosFactura && item.payload.datosFactura.numFactura) {
      let match = String(item.payload.datosFactura.numFactura).match(/\d+$/);
      if (match) {
        let n = parseInt(match[0], 10);
        if (n > ultimoNum) ultimoNum = n;
      }
    }
  });

  const cfgCorrelativo = await dbGet("config", "ultimoCorrelativo");
  if (cfgCorrelativo && typeof cfgCorrelativo.value === "number" && cfgCorrelativo.value > ultimoNum) {
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
            if (facStr) {
              let match = String(facStr).match(/\d+$/);
              if (match) {
                let n = parseInt(match[0], 10);
                if (n > ultimoNum) ultimoNum = n;
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

    let badgeIVA = (tasaIVA === "G" || tasaIVA === "16")
      ? `<span class="badge bg-danger">G (16%)</span>`
      : (tasaIVA === "R" || tasaIVA === "8" ? `<span class="badge bg-info text-dark">R (8%)</span>` : `<span class="badge bg-secondary">E (0%)</span>`);

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

  if (elemCedula) elemCedula.value = cli.cedula || '';
  if (elemNombre) elemNombre.value = cli.nombre || 'N/D';
  if (elemTel) elemTel.value = cli.telefono || 'N/D';
  if (elemDir) elemDir.value = cli.direccion || '';

  const boxEncontrado = document.getElementById('boxClienteEncontrado');
  const boxNuevo = document.getElementById('boxClienteNuevo');
  if (boxEncontrado) boxEncontrado.classList.remove('hidden');
  if (boxNuevo) boxNuevo.classList.add('hidden');
}

function prepararNuevoClienteEnVista(cedula) {
  const elemRegCedula = document.getElementById('facRegCedula');
  const elemRegNombre = document.getElementById('facRegNombre');
  const elemRegTel = document.getElementById('facRegTelefono');
  const elemRegDir = document.getElementById('facRegDireccion');

  if (elemRegCedula) elemRegCedula.value = cedula.toUpperCase();
  if (elemRegNombre) elemRegNombre.value = "";
  if (elemRegTel) elemRegTel.value = "";
  if (elemRegDir) elemRegDir.value = "";

  const boxEncontrado = document.getElementById('boxClienteEncontrado');
  const boxNuevo = document.getElementById('boxClienteNuevo');
  if (boxEncontrado) boxEncontrado.classList.add('hidden');
  if (boxNuevo) boxNuevo.classList.remove('hidden');
}

async function registrarClienteFactura() {
  const cedula = document.getElementById('facRegCedula').value.trim().toUpperCase();
  const nombre = document.getElementById('facRegNombre').value.trim().toUpperCase();
  const telefono = document.getElementById('facRegTelefono').value.trim();
  const direccion = document.getElementById('facRegDireccion').value.trim() || null;
  const btn = document.getElementById('btnRegistrarClienteFac');

  if (!cedula || !nombre) {
    return mostrarAvisoFactura("Cédula y Nombre son obligatorios.");
  }

  if (btn) { btn.disabled = true; btn.textContent = "Registrando..."; }

  const clienteNuevo = { cedula, nombre, telefono, direccion };
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
      direccion: direccion
    }
  });

  if (btn) { btn.disabled = false; btn.textContent = "💾 Registrar Nuevo Cliente"; }

  mostrarAvisoFactura("Cliente registrado exitosamente ⚡");
  procesarColaSincronizacion();
}

// SELECCIÓN DE FORMA DE PAGO
function seleccionarMetodoPagoBoton(metodo, btnElem) {
  document.querySelectorAll('.btn-metodo-pago').forEach(b => b.classList.remove('active'));
  if (btnElem) btnElem.classList.add('active');

  document.getElementById('facFormaPagoSelect').value = metodo;
  evaluarFormaPagoFactura(metodo);
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
    let numFactura = await obtenerSiguienteCorrelativoLocal();

    const tasa = obtenerTasaBCV();
    let productosSummaryList = [];
    let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

    for (let key in items) {
      let item = items[key];
      productosSummaryList.push(`${key} (${item.cantidadTxt}) - $${item.precioTotal}`);
    }

    const tributos = calcularTotalesTributarios(items);
    let totalBs = tributos.totalGeneral * (tasa > 0 ? tasa : 1);
    const usuarioActivo = obtenerUsuarioActivo();
    const tablaPersonal = obtenerTablaVentasUsuario(usuarioActivo);

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
      items: items
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
  let filasProductosHtml = "";
  let i = 1;
  let esModoBs = (d.monedaVistaModal === "BS");
  let tasa = d.tasaBCV || 1;

  let items = d.items || ((transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura);

  for (let key in items) {
    let item = items[key];
    let precUnit = "";
    let itemTotalTxt = "";
    let tasaLetra = (item.tasaIVA || "E").toUpperCase();

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
        <td style="width:36%;" class="fw-bold">${key} <span class="small text-muted">(${tasaLetra})</span></td>
        <td style="width:24%;" class="text-center num-legible">${precUnit}</td>
        <td style="width:16%;" class="text-center num-legible">${item.cantidadTxt}</td>
        <td style="width:18%;" class="text-end fw-bold num-legible">${itemTotalTxt}</td>
      </tr>`;
  }

  let bloqueTotalesHtml = "";
  if (esModoBs) {
    let exentoBs = (d.montoExento || 0) * tasa;
    let baseBs = (d.montoBase || 0) * tasa;
    let ivaBs = (d.montoIVA || 0) * tasa;

    bloqueTotalesHtml = `
      <div class="d-flex justify-content-between small text-muted">
        <span>EXENTO (0%):</span>
        <span class="num-legible">Bs. ${exentoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>
      <div class="d-flex justify-content-between small text-muted">
        <span>BASE GRAVABLE (16%):</span>
        <span class="num-legible">Bs. ${baseBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>
      <div class="d-flex justify-content-between small text-danger fw-bold">
        <span>IVA (16%):</span>
        <span class="num-legible">Bs. ${ivaBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>
      <div class="ticket-divider"></div>
      <div class="d-flex justify-content-between">
        <span>TOTAL FACTURA (Bs):</span>
        <strong class="fs-6 num-legible">Bs. ${d.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
      </div>
      <div class="d-flex justify-content-between text-muted">
        <span>TOTAL REF ($):</span>
        <span class="num-legible">$${d.totalUSD.toFixed(2)}</span>
      </div>`;
  } else {
    bloqueTotalesHtml = `
      <div class="d-flex justify-content-between small text-muted">
        <span>EXENTO (0%):</span>
        <span class="num-legible">$${(d.montoExento || 0).toFixed(2)}</span>
      </div>
      <div class="d-flex justify-content-between small text-muted">
        <span>BASE GRAVABLE (16%):</span>
        <span class="num-legible">$${(d.montoBase || 0).toFixed(2)}</span>
      </div>
      <div class="d-flex justify-content-between small text-danger fw-bold">
        <span>IVA (16%):</span>
        <span class="num-legible">$${(d.montoIVA || 0).toFixed(2)}</span>
      </div>
      <div class="ticket-divider"></div>
      <div class="d-flex justify-content-between">
        <span>TOTAL FACTURA ($):</span>
        <strong class="fs-6 num-legible">$${d.totalUSD.toFixed(2)}</strong>
      </div>
      <div class="d-flex justify-content-between text-muted">
        <span>TOTAL REF (Bs):</span>
        <span class="num-legible">Bs. ${d.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>`;
  }

  const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "FISCAL";
  const tipoEncabezado = d.modoFiscal ? `COMPROBANTE FISCAL PREVIO (${nombreModelo.toUpperCase()})` : "COMPROBANTE NO FISCAL - NOTA DE ENTREGA";

  const ticketHtml = `
    <div class="ticket-container shadow-sm border">
      <div class="ticket-header">
        <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
        <div class="ticket-title fs-6">${tipoEncabezado}</div>
        <div>RIF: J-505072889 | TELF: 0412-1753275</div>
        <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
        <div>HORARIO: 7:30am - 19:00pm</div>
      </div>

      <div class="ticket-info">
        <div><strong>FACTURA N°:</strong> <span class="fs-6 num-legible">${d.numFactura}</span></div>
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

      <div class="ticket-footer">
        <div>¡Gracias por su preferencia!</div>
      </div>
    </div>
  `;

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

    // 3. Guardar en IndexedDB local
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
      esFiscal: esFiscalActivo
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
          esFiscal: esFiscalActivo
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
    const filas = document.querySelectorAll('.fila-producto-cfg');
    let categoriasMap = {};

    cacheCategoriasFactura.forEach(c => {
      categoriasMap[c.nombre] = [];
    });

    for (let f of filas) {
      const origName = f.getAttribute('data-original-name');
      const origCat = f.getAttribute('data-original-cat');

      const nuevoPlu = f.querySelector('.cfg-plu').value.trim();
      const nuevoNom = f.querySelector('.cfg-nombre').value.trim();
      const nuevaCat = f.querySelector('.cfg-cat').value;
      const nuevaUnidad = f.querySelector('.cfg-unidad').value;
      const nuevoPeso = (nuevaUnidad === 'mixto') ? parseInt(f.querySelector('.cfg-pesoprom').value) || 2000 : 0;
      const nuevoOrden = parseInt(f.querySelector('.cfg-orden').value) || 1;
      const nuevoMin = parseInt(f.querySelector('.cfg-minimo').value) || 1;
      const nuevoDisp = (f.querySelector('.cfg-disp').value === "true");
      const nuevoIVA = f.querySelector('.cfg-iva') ? f.querySelector('.cfg-iva').value : "E";
      const nuevoPrecio = parseFloat(f.querySelector('.cfg-precio').value) || 0;
      const fileInput = f.querySelector('.cfg-file');

      if (!nuevoNom || nuevoPrecio <= 0) continue;

      let imgPathActual = "";
      const catVieja = cacheCategoriasFactura.find(c => c.nombre === origCat);
      if (catVieja) {
        const prodViejo = catVieja.productos.find(p => p[0] === origName);
        if (prodViejo) imgPathActual = prodViejo[2];
      }

      if (fileInput && fileInput.files && fileInput.files.length > 0) {
        const imgData = await validarYLeerArchivoWebPFac(fileInput);
        if (imgData) {
          const filePath = `img/${imgData.name}`;
          await subirArchivoAGitHubFactura(filePath, imgData.base64, `Subida de imagen: ${imgData.name}`);
          imgPathActual = filePath;
        }
      }

      if (!categoriasMap[nuevaCat]) categoriasMap[nuevaCat] = [];

      categoriasMap[nuevaCat].push({
        datos: [nuevoNom, nuevoPrecio, imgPathActual, nuevoDisp, nuevoMin, nuevaUnidad, nuevoPeso, nuevoPlu, nuevoIVA],
        orden: nuevoOrden
      });
    }

    cacheCategoriasFactura.forEach(cat => {
      let prodsEnCat = categoriasMap[cat.nombre] || [];
      prodsEnCat.sort((a, b) => a.orden - b.orden);
      cat.productos = prodsEnCat.map(p => p.datos);
    });

    const contentString = JSON.stringify({ categorias: cacheCategoriasFactura }, null, 2);
    const base64Content = btoa(unescape(encodeURIComponent(contentString)));

    await subirArchivoAGitHubFactura("catalog.json", base64Content, "Actualización completa de catálogo con IVA desde tabla Fullscreen POS");

    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Guardar Todos los Cambios";
    }

    renderizarCatalogoFacturacion({ categorias: cacheCategoriasFactura });
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalGestionCodigos')).hide();
    mostrarAvisoFactura("🎉 Catálogo completo con IVA actualizado y sincronizado con éxito.");

  } catch (err) {
    sessionStorage.removeItem("github_token");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Guardar Todos los Cambios";
    }
    console.error("Error al guardar en GitHub:", err);
    mostrarAvisoFactura("❌ Error de clave/sincronización con GitHub: " + err.message);
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
              esFiscal: Boolean(f.esFiscal || String(f.formaPagoStr || "").includes("FISCAL"))
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
              esFiscal: Boolean(String(v["FORMA DE PAGO"] || "").includes("FISCAL") || v.esFiscal)
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
    const formaStr = String(f.formaPagoStr || "").toUpperCase();
    const esRealmenteFiscal = Boolean(
      f.esFiscal === true || 
      f.esFiscal === "true" || 
      formaStr.includes("FISCAL") || 
      numFacStr.startsWith("FAC-") || 
      /^\d{8}$/.test(numFacStr)
    );

    let badgeTipo = esRealmenteFiscal 
      ? `<span class="badge bg-primary fw-bold">🏷️ Fiscal</span>` 
      : `<span class="badge bg-secondary">📄 No Fiscal</span>`;

    html += `
      <tr>
        <td class="fw-bold text-center text-danger num-legible">${f.numFactura}</td>
        <td class="text-center">${badgeTipo}</td>
        <td class="text-center small num-legible">${f.fechaStr}</td>
        <td class="fw-bold text-center num-legible">${f.cedula}</td>
        <td class="fw-bold text-wrap">${f.nombre}</td>
        <td class="small text-muted">${f.formaPagoStr}</td>
        <td class="text-end fw-bold text-success num-legible">$${parseFloat(f.montoTotalUSD).toFixed(2)}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-primary py-0 px-2 fw-bold rounded-pill me-1" onclick="reimprimirFacturaHistorial('${f.numFactura}')" title="Reimprimir Ticket">
            🖨️ Imprimir
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fw-bold rounded-pill" onclick="eliminarFacturaHistorial('${f.numFactura}')" title="Eliminar Factura">
            🗑️
          </button>
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

  const ticketHtml = `
    <div class="ticket-container shadow-sm border">
      <div class="ticket-header">
        <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
        <div>RIF: J-505072889 | TELF: 0412-1753275</div>
        <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
        <div>HORARIO: 7:30am - 19:00pm</div>
      </div>

      <div class="ticket-info">
        <div><strong>FACTURA N°:</strong> <span class="fs-6 num-legible">${d.numFactura}</span> (COPIA)</div>
        <div><strong>FECHA:</strong> <span class="num-legible">${d.fechaStr}</span></div>
        <div><strong>CLIENTE:</strong> ${d.cliente.nombre}</div>
        <div><strong>CI/RIF:</strong> <span class="num-legible">${d.cliente.cedula}</span></div>
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

// 2. GENERADOR Y EXPORTADOR OFICIAL DEL LIBRO DE VENTAS FISCAL SENIAT (.xlsx y .pdf)
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

    // Obtener ventas globales de la empresa
    let todasLasVentas = [];
    if (navigator.onLine) {
      todasLasVentas = await obtenerTodasLasVentasSupabase('ventas');
    } else {
      todasLasVentas = await dbGetAll("ventas");
    }

    if (!todasLasVentas || todasLasVentas.length === 0) {
      if (errorDiv) {
        errorDiv.textContent = "No se encontraron registros de ventas en la base de datos.";
        errorDiv.classList.remove('hidden');
      }
      return;
    }

    // Filtrar ÚNICAMENTE las facturas de tipo FISCAL emitidas dentro del período
    const ventasPeriodo = todasLasVentas.filter(v => {
      const formaStr = String(v["FORMA DE PAGO"] || v.formaPagoStr || "").toUpperCase();
      const numFac = String(v.FACTURA || v["FACTURA N°"] || v.numFactura || "");
      
      // Discriminador estricto de comprobante fiscal SENIAT
      const esRealmenteFiscal = Boolean(
        v.esFiscal === true ||
        v.esFiscal === "true" ||
        formaStr.includes("FISCAL") ||
        numFac.startsWith("FAC-") ||
        /^\d{8}$/.test(numFac)
      );

      // Excluir notas de entrega y comprobantes no fiscales
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

    if (ventasPeriodo.length === 0) {
      if (errorDiv) {
        errorDiv.textContent = `No se encontraron facturas fiscales registradas para el período seleccionado (${fechaDesdeStr} al ${fechaHastaStr}).`;
        errorDiv.classList.remove('hidden');
      }
      return;
    }

    // Procesar cada renglón fiscal del Libro de Ventas
    let filasSeniat = [];
    let totVentasBs = 0;
    let totExentoBs = 0;
    let totBase16Bs = 0;
    let totIVA16Bs = 0;
    let totBase8Bs = 0;
    let totIVA8Bs = 0;
    let operacionNro = 1;

    ventasPeriodo.forEach(v => {
      const numFac = String(v.FACTURA || v["FACTURA N°"] || v.numFactura || "");
      const fechaStr = String(v["FECHA"] || v.fechaStr || "").split(',')[0].trim();
      const cedulaRIF = String(v["CEDULA O RIF"] || v.cedula || "V-00000000").trim();
      const clienteNombre = String(v["NOMBRE / RAZON SOCIAL"] || v.nombre || "CONSUMIDOR FINAL").trim();
      const montoTotalUSD = parseFloat(v["MONTO TOTAL"] || v.montoTotalUSD) || 0;

      // Cálculo de bases e impuestos en Bolívares
      let totalVentaBs = 0;
      let evBS = parseFloat(v["EFECTIVO BOLIVARES"]) || 0;
      let pmBS = parseFloat(v["PAGO MOVIL"]) || 0;
      let pvBS = parseFloat(v["PUNTO DE VENTA"]) || 0;
      let trBS = parseFloat(v["TRANSFERENCIA"] || v["TRANSFERECIA"]) || 0;
      let bioBS = parseFloat(v["BIOPAGO"]) || 0;
      let sumaBolivares = evBS + pmBS + pvBS + trBS + bioBS;

      if (sumaBolivares > 0) {
        let evUSD = parseFloat(v["EFECTIVO DIVISAS"]) || 0;
        let zUSD = parseFloat(v["ZELLE"]) || 0;
        let ppUSD = parseFloat(v["PAYPAL"]) || 0;
        let cUSD = parseFloat(v["CASHEA"]) || 0;
        let crUSD = parseFloat(v["CREDITO"]) || 0;
        totalVentaBs = sumaBolivares + ((evUSD + zUSD + ppUSD + cUSD + crUSD) * tasaActual);
      } else {
        totalVentaBs = montoTotalUSD * tasaActual;
      }

      // Desglose Tributario de Productos
      const prodsStr = String(v["PRODUCTOS"] || v.productosSummary || "").toUpperCase();
      let exentoBs = 0;
      let base16Bs = 0;
      let iva16Bs = 0;
      let base8Bs = 0;
      let iva8Bs = 0;

      const itemsLista = prodsStr.split(' | ');
      itemsLista.forEach(itemTxt => {
        const matchUSD = itemTxt.match(/\$([0-9.]+)/);
        let montoItemUSD = matchUSD ? parseFloat(matchUSD[1]) : 0;
        let montoItemBs = montoItemUSD * tasaActual;

        if (itemTxt.includes('(G)') || itemTxt.includes('(16%)')) {
          let base = montoItemBs / 1.16;
          let iva = montoItemBs - base;
          base16Bs += base;
          iva16Bs += iva;
        } else if (itemTxt.includes('(R)') || itemTxt.includes('(8%)')) {
          let base = montoItemBs / 1.08;
          let iva = montoItemBs - base;
          base8Bs += base;
          iva8Bs += iva;
        } else {
          exentoBs += montoItemBs;
        }
      });

      // Si no hubo desglose específico en el texto, clasificar por el total
      if ((exentoBs + base16Bs + base8Bs) === 0 && totalVentaBs > 0) {
        exentoBs = totalVentaBs;
      }

      totVentasBs += totalVentaBs;
      totExentoBs += exentoBs;
      totBase16Bs += base16Bs;
      totIVA16Bs += iva16Bs;
      totBase8Bs += base8Bs;
      totIVA8Bs += iva8Bs;

      filasSeniat.push({
        nroOperacion: operacionNro++,
        fecha: fechaStr,
        cedulaRIF: cedulaRIF,
        cliente: clienteNombre,
        numFactura: numFac,
        numControl: "N/A",
        notaDebito: "",
        notaCredito: "",
        tipoTransaccion: "01-REG",
        facturaAfectada: "",
        totalVentaBs: totalVentaBs,
        exentoBs: exentoBs,
        base16Bs: base16Bs,
        alicuota16: "16%",
        iva16Bs: iva16Bs,
        base8Bs: base8Bs,
        alicuota8: "8%",
        iva8Bs: iva8Bs,
        igtfBs: 0.00,
        compRetencion: "",
        ivaRetenidoBs: 0.00
      });
    });

    // =========================================================================
    // MODALIDAD A: EXPORTACIÓN EN EXCEL (Formato Legal SENIAT)
    // =========================================================================
    if (formato === 'excel') {
      const filasExcel = [
        ["FRIGORIFICO MUNDOCARNES, C.A."],
        ["RIF: J-505072889"],
        [`LIBRO DE VENTAS FISCAL - SENIAT (Providencia N° SNAT/2014/0032)`],
        [`Período de Imposición: ${mesNombre.toUpperCase()} ${anioFiscal} - (${periodoTexto}) | Tasa Ref: Bs. ${tasaActual.toFixed(2)}`],
        [],
        [
          "N° Oper.", "Fecha", "RIF / C.I.", "Nombre / Razón Social", "N° Factura", 
          "N° Control", "N° Nota Déb.", "N° Nota Créd.", "Tipo Trans.", "Fact. Afectada",
          "Total Ventas Incl. IVA (Bs.)", "Ventas Exentas (Bs.)", "Base Imponible 16% (Bs.)", 
          "% Alic. 16%", "Impuesto IVA 16% (Bs.)", "Base Imponible 8% (Bs.)", "% Alic. 8%", 
          "Impuesto IVA 8% (Bs.)", "IGTF Percibido 3% (Bs.)", "N° Comprobante Ret.", "IVA Retenido (Bs.)"
        ]
      ];

      filasSeniat.forEach(f => {
        filasExcel.push([
          f.nroOperacion, f.fecha, f.cedulaRIF, f.cliente, f.numFactura,
          f.numControl, f.notaDebito, f.notaCredito, f.tipoTransaccion, f.facturaAfectada,
          parseFloat(f.totalVentaBs.toFixed(2)), parseFloat(f.exentoBs.toFixed(2)), 
          parseFloat(f.base16Bs.toFixed(2)), f.alicuota16, parseFloat(f.iva16Bs.toFixed(2)),
          parseFloat(f.base8Bs.toFixed(2)), f.alicuota8, parseFloat(f.iva8Bs.toFixed(2)),
          f.igtfBs, f.compRetencion, f.ivaRetenidoBs
        ]);
      });

      // Fila de Totales
      filasExcel.push([]);
      filasExcel.push([
        "TOTALES:", "", "", "", "", "", "", "", "", "",
        parseFloat(totVentasBs.toFixed(2)), parseFloat(totExentoBs.toFixed(2)), 
        parseFloat(totBase16Bs.toFixed(2)), "", parseFloat(totIVA16Bs.toFixed(2)),
        parseFloat(totBase8Bs.toFixed(2)), "", parseFloat(totIVA8Bs.toFixed(2)),
        0.00, "", 0.00
      ]);

      const worksheet = XLSX.utils.aoa_to_sheet(filasExcel);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Libro_Ventas_SENIAT");

      const nombreArchivo = `Libro_Ventas_SENIAT_${mesNombre}_${anioFiscal}_${fechaDesdeStr}_al_${fechaHastaStr}.xlsx`;
      XLSX.writeFile(workbook, nombreArchivo);

      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFiltroDescarga')).hide();
      mostrarAvisoFactura("🎉 Libro de Ventas Fiscal SENIAT (.xlsx) generado con éxito.");

    } else {
      // =========================================================================
      // MODALIDAD B: EXPORTACIÓN EN PDF APAISADO (Landscape SENIAT)
      // =========================================================================
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

      // Encabezado Fiscal Oficial
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text("FRIGORIFICO MUNDOCARNES, C.A.", 14, 12);
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "normal");
      doc.text("RIF: J-505072889 | Dirección: Av. San Martín, Caracas, Distrito Capital", 14, 16);
      doc.setFont("helvetica", "bold");
      doc.text(`LIBRO DE VENTAS FISCAL - SENIAT (Providencia N° SNAT/2014/0032)`, 14, 20);
      doc.setFont("helvetica", "normal");
      doc.text(`Período de Imposición: ${mesNombre.toUpperCase()} ${anioFiscal} (${fechaDesdeStr} al ${fechaHastaStr}) | Tasa Ref: Bs. ${tasaActual.toFixed(2)}`, 14, 24);

      // Tabla Formateada con AutoTable
      const columnasPDF = [
        "#", "Fecha", "RIF / C.I.", "Cliente / Razón Social", "N° Factura", "Tipo", 
        "Total Ventas (Bs)", "Exento (Bs)", "Base 16% (Bs)", "IVA 16% (Bs)", "Base 8% (Bs)", "IVA 8% (Bs)"
      ];

      const filasPDF = filasSeniat.map(f => [
        f.nroOperacion,
        f.fecha,
        f.cedulaRIF,
        f.cliente.length > 22 ? f.cliente.substring(0, 22) + "..." : f.cliente,
        f.numFactura,
        f.tipoTransaccion,
        f.totalVentaBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.exentoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.base16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.iva16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.base8Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        f.iva8Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      ]);

      // Fila de Totales en PDF
      filasPDF.push([
        "TOTAL", "", "", "RESUMEN DEL PERÍODO", "", "",
        totVentasBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totExentoBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totBase16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totIVA16Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totBase8Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        totIVA8Bs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      ]);

      doc.autoTable({
        head: [columnasPDF],
        body: filasPDF,
        startY: 27,
        theme: "grid",
        styles: { fontSize: 6.8, cellPadding: 1.2, halign: "center", lineColor: [200, 200, 200], lineWidth: 0.1 },
        headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 6.8 },
        columnStyles: {
          3: { halign: "left", cellWidth: 38 },
          6: { halign: "right", fontStyle: "bold" },
          7: { halign: "right" },
          8: { halign: "right" },
          9: { halign: "right", textColor: [180, 0, 0] },
          10: { halign: "right" },
          11: { halign: "right" }
        },
        footStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: "bold" }
      });

      const nombreArchivoPDF = `Libro_Ventas_SENIAT_${mesNombre}_${anioFiscal}_${fechaDesdeStr}_al_${fechaHastaStr}.pdf`;
      doc.save(nombreArchivoPDF);

      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFiltroDescarga')).hide();
      mostrarAvisoFactura("🎉 Libro de Ventas Fiscal SENIAT (.pdf) exportado con éxito.");
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

// CIERRE DE CAJA (CARGA AUTOMÁTICA DEL SALDO INICIAL APERTURADO)
function abrirModalCierreCaja() {
  const usuario = obtenerUsuarioActivo();
  const elemUsuario = document.getElementById('cierreUsuarioNombre');
  if (elemUsuario) {
    elemUsuario.textContent = `👤 Cajero: ${usuario.toUpperCase()}`;
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

  document.getElementById('errorModalCierrePaso1').classList.add('hidden');
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
        cacheHistorialCierres = cierresSup.map(c => ({
          id: c.id,
          fechaStr: c["FECHA"] || "",
          usuario: usuarioActivo,
          inicialUSD: parseFloat(c["INICIAL $"]) || 0,
          inicialBS: parseFloat(c["INICIAL Bs"]) || 0,
          cajaFinalUSD: parseFloat(c["TOTAL 3"]) || 0,
          cajaFinalBS: parseFloat(c["TOTAL 4"]) || 0,
          totalVentasUSD: parseFloat(c["TOTAL 1"]) || 0,
          totalVentasBS: parseFloat(c["TOTAL 2"]) || 0,
          esFiscal: c["FORMA DE PAGO"] ? c["FORMA DE PAGO"].includes("FISCAL") : false,
          numeroZ: c["NUMERO Z"] || null,
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
        })).sort((a, b) => (b.id || 0) - (a.id || 0));

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
    let badgeTipoCierre = c.numeroZ || c.esFiscal 
      ? `<span class="badge bg-primary fw-bold">Z Fiscal ${c.numeroZ ? '#' + c.numeroZ : ''}</span>` 
      : `<span class="badge bg-secondary">Z Interno</span>`;

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

    // 2. Acumuladores Fiscales Exclusivos (Únicamente ventas HKA80 del usuario)
    let resumenFiscal = {
      ventasEfectivoUSD: 0, ventasEfectivoBS: 0, ventasPagoMovil: 0,
      ventasZelle: 0, ventasPayPal: 0, ventasCashea: 0, ventasCredito: 0,
      ventasPuntoVenta: 0, ventasTransferencia: 0, ventasBiopago: 0,
      totalFiscalUSD: 0, totalFiscalBS: 0,
      cantFacturasFiscales: 0,
      facturaInicialFiscal: null, facturaFinalFiscal: null,
      listaFacturasFiscales: []
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

        // B. Acumular en Resumen Fiscal
        if (esFiscal) {
          resumenFiscal.cantFacturasFiscales++;
          resumenFiscal.listaFacturasFiscales.push(numFac);

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
  const nombreModelo = window.fiscalDriver ? window.fiscalDriver.getNombreModelo() : "THE FACTORY HKA80";
  const factorTasa = (parseFloat(d.tasaBCV) > 0) ? parseFloat(d.tasaBCV) : 1;

  let ticketHtml = "";

  if (d.modoFiscal) {
    // =========================================================================
    // FORMATO A: REPORTE Z FISCAL OFICIAL (AISLADO AL USUARIO Y VENTAS FISCALES)
    // =========================================================================
    const cantFiscales = rFisc.cantFacturasFiscales || 0;
    const ultFac = rFisc.facturaFinalFiscal || "00000000";

    ticketHtml = `
      <div class="ticket-container shadow-sm border text-start">
        <div class="ticket-header">
          <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
          <div class="small fw-bold">SENIAT</div>
          <div class="small fw-bold">RIF J-505072889</div>
          <div class="fw-bold fs-6">FRIGORIFICO MUNDOCARNES, C.A</div>
          <div class="small">AV. SAN MARTIN, CARACAS, DISTRITO CAPITAL</div>
          <div class="ticket-title mt-2 fs-6">REPORTE Z (CIERRE DIARIO)</div>
          <div class="small text-muted">${nombreModelo.toUpperCase()}</div>
        </div>

        <div class="ticket-info">
          <div><strong>FECHA / HORA:</strong> <span class="num-legible">${d.fechaStr}</span></div>
          <div><strong>CAJERO(A):</strong> ${d.usuario}</div>
          <div><strong>TASA BCV:</strong> <span class="num-legible">Bs. ${factorTasa.toFixed(2)}</span></div>
        </div>

        <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
          1. RESUMEN DE VENTAS FISCALES
        </div>
        <table class="ticket-table mb-2">
          <tbody>
            <tr>
              <td># FACTURAS FISCALES DEL DÍA:</td>
              <td class="text-end fw-bold text-primary num-legible">${cantFiscales} facturas</td>
            </tr>
            <tr>
              <td>ÚLTIMA FACTURA EMITIDA:</td>
              <td class="text-end fw-bold text-danger num-legible">${ultFac}</td>
            </tr>
          </tbody>
        </table>

        <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
          2. MEDIOS DE PAGO FISCALES
        </div>
        <table class="ticket-table mb-2">
          <tbody>
            <tr>
              <td>PUNTO DE VENTA (DÉBITO/CRÉDITO):</td>
              <td class="text-end fw-bold num-legible">Bs. ${(rFisc.ventasPuntoVenta || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td>PAGO MÓVIL / OTROS MEDIOS:</td>
              <td class="text-end fw-bold num-legible">Bs. ${(rFisc.ventasPagoMovil || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td>EFECTIVO BOLÍVARES:</td>
              <td class="text-end fw-bold num-legible">Bs. ${(rFisc.ventasEfectivoBS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            </tr>
            <tr>
              <td>EFECTIVO DIVISAS:</td>
              <td class="text-end fw-bold num-legible">$${(rFisc.ventasEfectivoUSD || 0).toFixed(2)}</td>
            </tr>
            <tr>
              <td>CASHEA:</td>
              <td class="text-end fw-bold num-legible">$${(rFisc.ventasCashea || 0).toFixed(2)}</td>
            </tr>
          </tbody>
        </table>

        <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
          3. TOTALES FISCALES DEL DÍA (SENIAT)
        </div>
        <div class="ticket-totals border-top pt-1">
          <div class="d-flex justify-content-between">
            <span>TOTAL INGRESOS BOLÍVARES (Bs):</span>
            <strong class="fs-5 text-dark num-legible">Bs. ${(rFisc.totalFiscalBS || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          </div>
          <div class="d-flex justify-content-between">
            <span>TOTAL INGRESOS DIVISAS ($):</span>
            <strong class="fs-5 text-success num-legible">$${(rFisc.totalFiscalUSD || 0).toFixed(2)}</strong>
          </div>
          <div class="ticket-divider"></div>
          <div class="d-flex justify-content-between text-success fw-bold">
            <span>EFECTIVO TOTAL EN GAVETA ($):</span>
            <span class="fs-6 num-legible">$${d.totalCajaUSD.toFixed(2)}</span>
          </div>
          <div class="d-flex justify-content-between text-primary fw-bold">
            <span>EFECTIVO TOTAL EN GAVETA (Bs):</span>
            <span class="fs-6 num-legible">Bs. ${d.totalCajaBS.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        </div>

        <div class="ticket-footer mt-3">
          <div class="mt-4 pt-3 border-top border-dark text-center">
            ____________________________________<br>
            <strong>FIRMA Y CONFORMIDAD CAJERO(A)</strong>
          </div>
          <div class="small mt-2">DOCUMENTO FISCAL DE CIERRE DIARIO</div>
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
