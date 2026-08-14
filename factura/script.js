/* ==========================================================================
   Lógica del Módulo de Ventas / Facturación No Fiscal - Mundocarnes
   Base de Datos PostgreSQL en Supabase con Mapeo Exacto de Columnas
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

// Pre-carga inmediata del logotipo oficial para comprobantes impresos en memoria
const logoComprobantePreload = new Image();
logoComprobantePreload.src = "../img/LOGO-MUNDO123.webp";

// Clasificación de Métodos por Naturaleza de Moneda
const METODOS_USD = ["Efectivo Divisas", "Zelle", "PayPal", "Cashea"];
const METODOS_BS = ["Pago Móvil", "Efectivo Bolívares", "Punto de Venta", "Transferencia Bancaria", "Biopago"];

let itemsFactura = {};
let transaccionActiva = null; // Transacción en curso dentro del modal de procesamiento
let facturasEnEspera = [];   // Arreglo de facturas minimizadas en Standby
let productoTemporalFactura = {};
let cacheCategoriasFactura = [];
let clienteFacturaActual = null;
let monedaVistaModal = "USD"; // Estado del conmutador: "USD" o "BS"
let datosFacturaPendiente = null;
let itemsEscaneadosTemporales = [];
let cacheHistorialFacturas = [];
let datosCierreCajaPendiente = null;
let listaFlatProductosCodigos = [];
let listaMovimientosEfectivo = [];
let cacheHistorialCierres = [];
let sincronizandoEnProceso = false;

// ==========================================================================
// MOTOR DE BASE DE DATOS LOCAL INDEXEDDB (OFFLINE-FIRST A 0ms)
// ==========================================================================
function abrirDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("MundocarnesPOS_DB", 2);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("clientes")) {
        db.createObjectStore("clientes", { keyPath: "cedula" });
      }
      if (!db.objectStoreNames.contains("ventas")) {
        db.createObjectStore("ventas", { keyPath: "numFactura" });
      }
      if (!db.objectStoreNames.contains("movimientos")) {
        db.createObjectStore("movimientos", { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("cierres")) {
        db.createObjectStore("cierres", { autoIncrement: true });
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
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function dbPut(storeName, item) {
  try {
    const db = await abrirDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.put(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error("Error dbPut:", e);
  }
}

async function dbGetAll(storeName) {
  try {
    const db = await abrirDB();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

async function dbDelete(storeName, key) {
  try {
    const db = await abrirDB();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch (e) {
    return false;
  }
}

// ==========================================================================
// MOTOR DE SINCRONIZACIÓN HACIA SUPABASE CON ESQUEMA EXACTO
// ==========================================================================
async function actualizarEstadoSyncBadge() {
  const badge = document.getElementById('badgeEstadoSync');
  if (!badge) return;

  const queue = await dbGetAll("syncQueue");
  const count = queue.length;

  if (!navigator.onLine) {
    badge.className = "badge bg-danger fw-bold me-2 px-2 py-1";
    badge.textContent = `🔴 Offline (${count} pend.)`;
  } else if (count > 0) {
    badge.className = "badge bg-warning text-dark fw-bold me-2 px-2 py-1";
    badge.textContent = `🟠 Sincronizando (${count})...`;
  } else {
    badge.className = "badge bg-success fw-bold me-2 px-2 py-1";
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
      let exito = false;

      if (payload.action === "guardarFacturaFinal") {
        const d = payload.datosFactura;
        const desgl = d.desglosePagos || {};

        const { error } = await supabaseClient.from('ventas').insert([{
          "FECHA": d.fechaStr || new Date().toLocaleString('es-VE'),
          "FACTURA N°": d.numFactura,
          "CEDULA O RIF": d.cedula,
          "NOMBRE / RAZON SOCIAL": d.nombre,
          "UBICACION": d.direccion || 'paraiso',
          "PRODUCTOS": d.productosSummary,
          "FORMA DE PAGO": d.formaPago,
          "MONTO TOTAL": parseFloat(d.montoTotal) || 0,
          "EFECTIVO DIVISAS": parseFloat(desgl["Efectivo Divisas"]) || 0,
          "EFECTIVO BOLIVARES": parseFloat(desgl["Efectivo Bolívares"]) || 0,
          "PAGO MOVIL": parseFloat(desgl["Pago Móvil"]) || 0,
          "ZELLE": parseFloat(desgl["Zelle"]) || 0,
          "PAYPAL": parseFloat(desgl["PayPal"]) || 0,
          "CASHEA": parseFloat(desgl["Cashea"]) || 0,
          "PUNTO DE VENTA": parseFloat(desgl["Punto de Venta"]) || 0,
          "TRANSFERENCIA": parseFloat(desgl["Transferencia Bancaria"]) || 0,
          "BIOPAGO": parseFloat(desgl["Biopago"]) || 0
        }]);

        if (!error) exito = true;
        else console.error("Error insert venta Supabase:", error);

      } else if (payload.action === "registrarClienteFactura") {
        const { error } = await supabaseClient.from('clientes').upsert({
          "CEDULA": payload.cedula,
          "NOMBRES": payload.nombre,
          "TELEFONO": payload.telefono,
          "DIRECCION": payload.direccion
        });

        if (!error) exito = true;
        else console.error("Error upsert cliente Supabase:", error);

      } else if (payload.action === "guardarCierreCaja") {
        const d = payload.datosCierre;
        const r = d.resumen || {};

        const { error } = await supabaseClient.from('cierres').insert([{
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
          "TRANSFERECIA": parseFloat(r.ventasTransferencia) || 0,
          "TOTAL 1": parseFloat(r.totalGeneralVentasUSD) || 0,
          "TOTAL 2": parseFloat(r.totalGeneralVentasBS) || 0,
          "TOTAL 3": parseFloat(d.totalCajaUSD) || 0,
          "TOTAL 4": parseFloat(d.totalCajaBS) || 0
        }]);

        if (!error) exito = true;
        else console.error("Error insert cierre Supabase:", error);

      } else if (payload.action === "eliminarFactura") {
        const { error } = await supabaseClient.from('ventas').delete().eq('FACTURA N°', payload.numFactura);
        if (!error) exito = true;
        else console.error("Error delete venta Supabase:", error);
      }

      if (exito) {
        await dbDelete("syncQueue", item.id);
      } else {
        break;
      }

    } catch (err) {
      console.warn("Aviso Sync Supabase:", err);
      break;
    }
  }

  sincronizandoEnProceso = false;
  actualizarEstadoSyncBadge();
}

// SINCRONIZACIÓN MANUAL BIDIRECCIONAL COMPLETA
async function forzarSincronizacionManual() {
  if (!navigator.onLine) {
    mostrarAvisoFactura("Dispositivo en Modo Offline. Conéctese a Internet para sincronizar.");
    return;
  }

  const badge = document.getElementById('badgeEstadoSync');
  if (badge) {
    badge.className = "badge bg-warning text-dark fw-bold me-2 px-2 py-1";
    badge.textContent = "🔄 Sincronizando...";
  }

  // PASO 1: Subida de transacciones pendientes locales
  mostrarAvisoFactura("🔄 Paso 1/4: Subiendo pendientes a Supabase (0%)...", false);
  const queue = await dbGetAll("syncQueue");

  if (queue.length === 0) {
    mostrarAvisoFactura("🔄 Paso 1/4: Transacciones locales al día (100%)", false);
    await new Promise(r => setTimeout(r, 400));
  } else {
    for (let i = 0; i < queue.length; i++) {
      let pct = Math.round(((i + 1) / queue.length) * 100);
      mostrarAvisoFactura(`🔄 Paso 1/4: Subiendo pendientes (${i + 1}/${queue.length} - ${pct}%)`, false);
      await new Promise(r => setTimeout(r, 60));

      try {
        await procesarColaSincronizacion();
      } catch (e) {
        break;
      }
    }
    mostrarAvisoFactura("🔄 Paso 1/4: Pendientes enviados al 100%", false);
    await new Promise(r => setTimeout(r, 400));
  }

  // PASO 2: Descarga de Clientes desde Supabase
  mostrarAvisoFactura("🔄 Paso 2/4: Consultando Clientes en Supabase...", false);
  let cantClientes = 0;
  try {
    const { data: clientesSup, error } = await supabaseClient.from('clientes').select('"CEDULA", "NOMBRES", "APELLIDOS", "TELEFONO", "DIRECCION"');
    if (!error && clientesSup) {
      const totalCli = clientesSup.length;
      cantClientes = totalCli;
      for (let i = 0; i < totalCli; i++) {
        let c = clientesSup[i];
        await dbPut("clientes", {
          cedula: c.CEDULA,
          nombre: c.NOMBRES || 'N/D',
          telefono: c.TELEFONO || 'N/D',
          direccion: c.DIRECCION || 'N/D'
        });
        let pct = Math.round(((i + 1) / totalCli) * 100);
        mostrarAvisoFactura(`🔄 Paso 2/4: Guardando Clientes (${i + 1}/${totalCli} - ${pct}%)`, false);
        await new Promise(r => setTimeout(r, totalCli > 50 ? 10 : 30));
      }
    }
  } catch (e) {
    console.error("Error clientes sync:", e);
  }
  mostrarAvisoFactura(`🔄 Paso 2/4: Clientes sincronizados (${cantClientes} registros)`, false);
  await new Promise(r => setTimeout(r, 400));

  // PASO 3: Descarga del Historial de Ventas desde Supabase
  mostrarAvisoFactura("🔄 Paso 3/4: Consultando Historial de Ventas...", false);
  let cantVentas = 0;
  try {
    const { data: ventasSup, error } = await supabaseClient.from('ventas').select('*').limit(200);
    if (!error && ventasSup) {
      const totalVen = ventasSup.length;
      cantVentas = totalVen;
      for (let i = 0; i < totalVen; i++) {
        let v = ventasSup[i];
        await dbPut("ventas", {
          numFactura: v["FACTURA N°"],
          fechaStr: v["FECHA"] || "",
          cedula: v["CEDULA O RIF"] || "",
          nombre: v["NOMBRE / RAZON SOCIAL"] || "",
          direccion: v["UBICACION"] || "",
          productosSummary: v["PRODUCTOS"] || "",
          formaPagoStr: v["FORMA DE PAGO"] || "",
          montoTotalUSD: parseFloat(v["MONTO TOTAL"]) || 0
        });
        let pct = Math.round(((i + 1) / totalVen) * 100);
        mostrarAvisoFactura(`🔄 Paso 3/4: Guardando Ventas (${i + 1}/${totalVen} - ${pct}%)`, false);
        await new Promise(r => setTimeout(r, totalVen > 50 ? 10 : 30));
      }
    }
  } catch (e) {
    console.error("Error ventas sync:", e);
  }
  mostrarAvisoFactura(`🔄 Paso 3/4: Ventas sincronizadas (${cantVentas} registros)`, false);
  await new Promise(r => setTimeout(r, 400));

  // PASO 4: Descarga del Historial de Cierres de Caja desde Supabase
  mostrarAvisoFactura("🔄 Paso 4/4: Consultando Cierres de Caja...", false);
  let cantCierres = 0;
  try {
    const { data: cierresSup, error } = await supabaseClient.from('cierres').select('*').order('id', { ascending: false }).limit(50);
    if (!error && cierresSup) {
      const totalCie = cierresSup.length;
      cantCierres = totalCie;
      for (let i = 0; i < totalCie; i++) {
        let cie = cierresSup[i];
        await dbPut("cierres", {
          id: cie.id,
          fechaStr: cie["FECHA"] || "",
          usuario: cie["USUARIO"] || "",
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
            ventasTransferencia: parseFloat(cie["TRANSFERECIA"]) || 0,
            totalGeneralVentasUSD: parseFloat(cie["TOTAL 1"]) || 0,
            totalGeneralVentasBS: parseFloat(cie["TOTAL 2"]) || 0
          }
        });
        let pct = Math.round(((i + 1) / totalCie) * 100);
        mostrarAvisoFactura(`🔄 Paso 4/4: Guardando Cierres (${i + 1}/${totalCie} - ${pct}%)`, false);
        await new Promise(r => setTimeout(r, totalCie > 50 ? 10 : 30));
      }
    }
  } catch (e) {
    console.error("Error cierres sync:", e);
  }
  mostrarAvisoFactura(`🔄 Paso 4/4: Cierres sincronizados (${cantCierres} registros)`, false);
  await new Promise(r => setTimeout(r, 600));

  await actualizarEstadoSyncBadge();
  mostrarAvisoFactura(`🎉 ¡Sincronización completada al 100%! (${cantClientes} clientes, ${cantVentas} ventas, ${cantCierres} cierres).`, true, 10000);
}

async function sincronizarClientesDesdeServidor() {
  if (!navigator.onLine) return;
  try {
    const { data, error } = await supabaseClient.from('clientes').select('"CEDULA", "NOMBRES", "APELLIDOS", "TELEFONO", "DIRECCION"');
    if (!error && data) {
      for (let cli of data) {
        await dbPut("clientes", {
          cedula: cli.CEDULA,
          nombre: cli.NOMBRES || 'N/D',
          telefono: cli.TELEFONO || 'N/D',
          direccion: cli.DIRECCION || 'N/D'
        });
      }
    }
  } catch (e) {}
}

// CORRELATIVO LOCAL Y EN LA NUBE
async function obtenerSiguienteCorrelativoLocal() {
  let ultimoNum = 0;

  // 1. Revisar ventas locales en IndexedDB
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

  // 2. Si hay conexión, consultar la mayor factura registrada en Supabase
  if (navigator.onLine) {
    try {
      const { data: ultimasVentas } = await supabaseClient
        .from('ventas')
        .select('"FACTURA N°"')
        .order('FACTURA N°', { ascending: false })
        .limit(100);

      if (ultimasVentas && ultimasVentas.length > 0) {
        ultimasVentas.forEach(v => {
          let facStr = v["FACTURA N°"];
          if (facStr) {
            let match = String(facStr).match(/\d+$/);
            if (match) {
              let n = parseInt(match[0], 10);
              if (n > ultimoNum) ultimoNum = n;
            }
          }
        });
      }
    } catch (e) {}
  }

  let siguienteNum = ultimoNum + 1;
  await dbPut("config", { key: "ultimoCorrelativo", value: siguienteNum });

  let numPadded = String(siguienteNum).padStart(5, '0');
  return "001-" + numPadded;
}

// IMPRESIÓN
function ejecutarImpresionTicket(ticketHtml) {
  const elemImpresion = document.getElementById('contenidoTicketImprimible');
  if (!elemImpresion) return;

  elemImpresion.innerHTML = ticketHtml;

  const img = elemImpresion.querySelector('img.ticket-logo-centrado');
  if (img && !img.complete) {
    img.onload = function () {
      window.print();
    };
    img.onerror = function () {
      window.print();
    };
  } else {
    window.print();
  }
}

// MANEJADOR DE CAPAS (Z-INDEX)
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

function mostrarAvisoFactura(mensaje, autohide = true, delay = 6000) {
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
  } catch (e) {
    console.warn("Aviso Toast:", mensaje);
  }
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
      btn.className = "btn btn-sm btn-dark fw-bold";
    } else {
      btn.textContent = "💱 Ver en Bolívares (Bs)";
      btn.className = "btn btn-sm btn-outline-dark fw-bold";
    }
  }

  renderizarTablaModalFactura();
  calcularTotalPagoMixto();
}

function renderizarTablaModalFactura() {
  const tasa = obtenerTasaBCV();
  let htmlTabla = "";
  let totalUSD = 0;

  const items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

  for (let key in items) {
    let item = items[key];
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
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 border-0 fw-bold" onclick="eliminarItemFacturaEnProceso('${key}')" title="Eliminar del detalle">✕</button>
        </td>
      </tr>`;
  }

  const tbody = document.getElementById('tablaModalResumenProductos');
  if (tbody) {
    tbody.innerHTML = htmlTabla || `<tr><td colspan="6" class="text-center text-muted py-3">No hay productos en esta factura.</td></tr>`;
  }

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

function eliminarItemFacturaEnProceso(nombreProducto) {
  if (transaccionActiva && transaccionActiva.items) {
    delete transaccionActiva.items[nombreProducto];
    renderizarTablaModalFactura();
    actualizarCalculosBCV();

    if (Object.keys(transaccionActiva.items).length === 0) {
      mostrarAvisoFactura("Se han eliminado todos los productos de la factura.");
    }
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

// FUNCIONES PRODUCTO MANUAL
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

// INICIO DE SESIÓN CON SUPABASE (COLUMNAS EXACTAS)
async function procesarLoginFacturacion(event) {
  event.preventDefault();
  
  const usuario = document.getElementById('facUsuario').value.trim().toLowerCase();
  const password = document.getElementById('facPassword').value.trim();
  const btn = document.getElementById('btnIngresarFac');

  if (!usuario || !password) {
    return mostrarAvisoFactura("Ingrese usuario y contraseña.");
  }

  btn.disabled = true;
  btn.textContent = "Verificando en Supabase...";

  try {
    const { data, error } = await supabaseClient
      .from('usuarios_factur')
      .select('*')
      .eq('NOMBRE DE USUARIO', usuario)
      .eq('CLAVE', password)
      .maybeSingle();

    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema 🔐";

    if (!error && data) {
      let token = btoa(usuario + ":" + Date.now());
      sessionStorage.setItem("factura_token", token);
      sessionStorage.setItem("factura_usuario", usuario);
      iniciarModuloFacturacion(usuario);
    } else {
      mostrarAvisoFactura("Usuario o contraseña incorrectos.");
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Ingresar al Sistema 🔐";
    mostrarAvisoFactura("Error de conexión al autenticar con Supabase.");
    console.error("Error Login Supabase:", err);
  }
}

function iniciarModuloFacturacion(usuario) {
  document.getElementById('vistaLogin').classList.add('hidden');
  document.getElementById('vistaFacturacion').classList.remove('hidden');
  document.getElementById('usuarioActivo').textContent = `👤 Usuario: ${usuario.toUpperCase()}`;
  
  cargarCatalogoFacturacion();
  cargarMovimientosEfectivoPersistentes();
  
  if (navigator.onLine) {
    sincronizarClientesDesdeServidor();
    procesarColaSincronizacion();
  }
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

function ejecutarFacturar() {
  if (Object.keys(itemsFactura).length === 0) {
    return mostrarAvisoFactura("Seleccione al menos un producto para facturar.");
  }

  transaccionActiva = {
    id: "tx_" + Date.now(),
    horaPausa: new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }),
    items: { ...itemsFactura },
    cliente: null,
    formaPago: "",
    tasaBCV: obtenerTasaBCV()
  };

  itemsFactura = {};
  renderizarResumenFactura();

  monedaVistaModal = "USD";
  const btnConmutar = document.getElementById('btnConmutarMoneda');
  if (btnConmutar) {
    btnConmutar.textContent = "💱 Ver en Bolívares (Bs)";
    btnConmutar.className = "btn btn-sm btn-outline-dark fw-bold";
  }

  document.querySelectorAll('.btn-metodo-pago').forEach(b => b.classList.remove('active'));
  document.getElementById('facFormaPagoSelect').value = "";

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

// LÓGICA DE STANDBY / FACTURAS EN ESPERA
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
        <td class="text-end fw-bold text-success">$${total.toFixed(2)}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-success py-0 px-2 fw-bold me-1" onclick="reanudarFacturaEnEspera(${idx})">
            ▶️ Reanudar
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fw-bold" onclick="eliminarFacturaEnEspera(${idx})">
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

// BÚSQUEDA DE CLIENTE EN SUPABASE (COLUMNA EXACTA "CEDULA")
async function buscarClienteFactura() {
  const inputCedula = document.getElementById('facCedulaBuscar');
  const cedula = inputCedula ? inputCedula.value.trim().toUpperCase() : "";
  
  if (!cedula) {
    return mostrarAvisoFactura("Ingrese la Cédula o RIF.");
  }

  const btn = document.getElementById('btnBuscarClienteFac');
  if (btn) { btn.disabled = true; btn.textContent = "Buscando..."; }

  // 1. Consulta ultrarrápida a IndexedDB local
  let clienteLocal = await dbGet("clientes", cedula);
  if (clienteLocal) {
    if (btn) { btn.disabled = false; btn.textContent = "🔍 Buscar"; }
    clienteFacturaActual = clienteLocal;
    poblarClienteEnVista(clienteLocal);
    mostrarAvisoFactura("Cliente localizado localmente ⚡");
    return;
  }

  // 2. Consulta a Supabase con columna "CEDULA"
  if (navigator.onLine) {
    try {
      let { data: resSup, error } = await supabaseClient
        .from('clientes')
        .select('"CEDULA", "NOMBRES", "APELLIDOS", "TELEFONO", "DIRECCION"')
        .eq('CEDULA', cedula)
        .maybeSingle();

      if (btn) { btn.disabled = false; btn.textContent = "🔍 Buscar"; }

      if (!error && resSup) {
        let cliObj = {
          cedula: resSup.CEDULA,
          nombre: resSup.NOMBRES || 'N/D',
          telefono: resSup.TELEFONO || 'N/D',
          direccion: resSup.DIRECCION || 'N/D'
        };
        clienteFacturaActual = cliObj;
        await dbPut("clientes", cliObj);
        poblarClienteEnVista(cliObj);
        mostrarAvisoFactura("Cliente localizado con éxito en Supabase.");
        return;
      }
    } catch (err) {
      console.warn("Aviso Supabase Cliente:", err);
    }
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
  if (elemDir) elemDir.value = cli.direccion || 'N/D';

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

// REGISTRO DE CLIENTE NUEVO EN SUPABASE
async function registrarClienteFactura() {
  const cedula = document.getElementById('facRegCedula').value.trim().toUpperCase();
  const nombre = document.getElementById('facRegNombre').value.trim().toUpperCase();
  const telefono = document.getElementById('facRegTelefono').value.trim();
  const direccion = document.getElementById('facRegDireccion').value.trim();

  if (!cedula || !nombre) {
    return mostrarAvisoFactura("Cédula y Nombre son obligatorios.");
  }

  const clienteNuevo = { cedula, nombre, telefono, direccion };
  clienteFacturaActual = clienteNuevo;

  await dbPut("clientes", clienteNuevo);
  poblarClienteEnVista(clienteNuevo);

  if (navigator.onLine) {
    try {
      await supabaseClient.from('clientes').upsert({
        "CEDULA": cedula,
        "NOMBRES": nombre,
        "TELEFONO": telefono,
        "DIRECCION": direccion
      });
    } catch (e) {}
  }

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
    prefijoSpan.className = "input-group-text border-dark simbolo-moneda-mixto bg-warning text-dark fw-bold";
  } else {
    prefijoSpan.textContent = "$";
    prefijoSpan.className = "input-group-text border-dark simbolo-moneda-mixto bg-light text-dark fw-bold";
  }
}

function agregarLineaPagoMixtoFija(metodoPredeterminado, esEliminable = true) {
  const lista = document.getElementById('listaFilasPagoMixto');
  if (!lista) return;

  const divFila = document.createElement('div');
  divFila.className = 'row g-2 mb-2 align-items-center fila-pago-mixto';

  const opciones = [
    "Cashea", "Efectivo Divisas", "Efectivo Bolívares", "Pago Móvil", 
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
        <option value="Biopago">Biopago</option>
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

// EMITIR FACTURA FINAL
async function emitirFacturaFinal() {
  if (!clienteFacturaActual) {
    return mostrarAvisoFactura("Debe buscar o registrar un cliente antes de emitir.");
  }

  const formaPagoStr = obtenerDetalleFormaPagoFinal();
  if (!formaPagoStr) return;

  const btn = document.getElementById('btnEmitirFacturaFinal');
  if (btn) { btn.disabled = true; btn.textContent = "Generando Ticket..."; }

  try {
    let numFactura = await obtenerSiguienteCorrelativoLocal();

    const tasa = obtenerTasaBCV();
    let totalUSD = 0;
    let productosSummaryList = [];

    let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

    for (let key in items) {
      let item = items[key];
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
      monedaVistaModal: monedaVistaModal,
      productosSummary: productosSummaryList.join(' | ')
    };

    renderizarTicketTermicoHTML(datosFacturaPendiente);
    if (btn) { btn.disabled = false; btn.textContent = "🧾 Emitir Factura"; }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalVistaPreviaFactura')).show();

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "🧾 Emitir Factura"; }
    console.error("Error al generar venta local:", err);
    mostrarAvisoFactura("Error al preparar el ticket de venta.");
  }
}

function renderizarTicketTermicoHTML(d) {
  let filasProductosHtml = "";
  let i = 1;
  let esModoBs = (d.monedaVistaModal === "BS");
  let tasa = d.tasaBCV || 1;

  let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

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
        <td style="width:38%;" class="fw-bold">${key}</td>
        <td style="width:24%;" class="text-center">${precUnit}</td>
        <td style="width:14%;" class="text-center">${item.cantidadTxt}</td>
        <td style="width:18%;" class="text-end fw-bold">${itemTotalTxt}</td>
      </tr>`;
  }

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

  const elemModal = document.getElementById('vistaPreviaTicketModal');
  if (elemModal) elemModal.innerHTML = ticketHtml;
}

function obtenerObjetoDesgloseMetodos() {
  const formaSelect = document.getElementById('facFormaPagoSelect').value;
  const tasa = obtenerTasaBCV();

  let desgl = {
    "Efectivo Divisas": 0,
    "Efectivo Bolívares": 0,
    "Pago Móvil": 0,
    "Zelle": 0,
    "PayPal": 0,
    "Cashea": 0,
    "Punto de Venta": 0,
    "Transferencia Bancaria": 0,
    "Biopago": 0
  };

  let totalUSD = 0;
  let items = (transaccionActiva && transaccionActiva.items) ? transaccionActiva.items : itemsFactura;

  for (let key in items) {
    totalUSD += parseFloat(items[key].precioTotal) || 0;
  }
  let totalBs = totalUSD * tasa;

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

// CONFIRMAR, IMPRIMIR E INICIAR SINCRONIZACIÓN
async function confirmarEImprimirFactura() {
  if (!datosFacturaPendiente) return;

  const btn = document.getElementById('btnConfirmarEmisionFinal');
  if (btn) { btn.disabled = true; btn.textContent = "Guardando e Imprimiendo..."; }

  try {
    let numFactura = datosFacturaPendiente.numFactura;

    // 1. Guardar localmente en IndexedDB
    await dbPut("ventas", {
      numFactura: numFactura,
      fechaStr: datosFacturaPendiente.fechaStr,
      montoTotalUSD: datosFacturaPendiente.totalUSD,
      cedula: datosFacturaPendiente.cliente.cedula,
      nombre: datosFacturaPendiente.cliente.nombre,
      direccion: datosFacturaPendiente.cliente.direccion || 'N/D',
      formaPagoStr: datosFacturaPendiente.formaPagoStr,
      productosSummary: datosFacturaPendiente.productosSummary
    });

    // 2. Encolar para sincronización con Supabase
    await dbPut("syncQueue", {
      id: "sync_fac_" + Date.now(),
      payload: {
        action: "guardarFacturaFinal",
        datosFactura: {
          numFactura: numFactura,
          fechaStr: datosFacturaPendiente.fechaStr,
          cedula: datosFacturaPendiente.cliente.cedula,
          nombre: datosFacturaPendiente.cliente.nombre,
          direccion: datosFacturaPendiente.cliente.direccion || 'paraiso',
          productosSummary: datosFacturaPendiente.productosSummary,
          formaPago: datosFacturaPendiente.formaPagoStr,
          montoTotal: datosFacturaPendiente.totalUSD,
          desglosePagos: datosFacturaPendiente.desglosePagos
        }
      }
    });

    // 3. Impresión térmica instantánea
    const ticketHtml = document.getElementById('vistaPreviaTicketModal').innerHTML;
    ejecutarImpresionTicket(ticketHtml);

    if (btn) { btn.disabled = false; btn.textContent = "🖨️ Confirmar y Facturar"; }

    itemsFactura = {};
    transaccionActiva = null;
    clienteFacturaActual = null;
    datosFacturaPendiente = null;
    renderizarResumenFactura();

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalVistaPreviaFactura')).hide();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalProcesarFactura')).hide();

    mostrarAvisoFactura(`Venta N° ${numFactura} emitida e impresa con éxito 🎉`);

    procesarColaSincronizacion();

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "🖨️ Confirmar y Facturar"; }
    console.error("Error al registrar venta local:", err);
    mostrarAvisoFactura("Error al guardar la venta localmente.");
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

// LÓGICA LECTOR CÓDIGOS DE BALANZA TECNISCALE PS-30
function abrirModalCodigos() {
  itemsEscaneadosTemporales = [];
  const input = document.getElementById('inputScannerQR');
  if (input) input.value = "";
  
  renderizarTablaEscaneados();
  
  const modalObj = bootstrap.Modal.getOrCreateInstance(document.getElementById('modalLectorCodigos'));
  modalObj.show();

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
            unidad: p[5]
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

  itemsEscaneadosTemporales.forEach((it, idx) => {
    if (it.encontrado) hayValidos = true;
    let badgeState = it.encontrado 
      ? `<span class="badge bg-success">✔ Encontrado</span>` 
      : `<span class="badge bg-danger">✕ No Registrado</span>`;

    let precUnitTxt = (it.unidad === 'gramos' || it.unidad === 'mixto') ? `$${it.precioBase.toFixed(2)}/Kg` : `$${it.precioBase.toFixed(2)}/Ud`;

    html += `
      <tr>
        <td class="fw-bold text-center">${it.codigoLeido}</td>
        <td class="fw-bold ${it.encontrado ? 'text-dark' : 'text-danger'}">${it.nombre}</td>
        <td class="text-center">${precUnitTxt}</td>
        <td class="text-center fw-bold text-primary">${it.cantidadTxt}</td>
        <td class="text-end fw-bold text-success">$${it.precioTotal}</td>
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

// LÓGICA GESTIÓN Y CONFIGURACIÓN DE PRODUCTOS
function abrirModalGestionCodigos() {
  document.getElementById('facFiltroCodigosInput').value = "";
  prepararListaProductosCodigos();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalGestionCodigos')).show();
}

function prepararListaProductosCodigos() {
  listaFlatProductosCodigos = [];

  cacheCategoriasFactura.forEach(cat => {
    cat.productos.forEach(p => {
      let nom = p[0];
      let prec = p[1];
      let esDisp = p[3] !== undefined ? p[3] : true;
      let unidad = p[5];
      let codPLU = p[7] ? String(p[7]).trim() : "";

      listaFlatProductosCodigos.push({
        nombre: nom,
        precio: prec,
        categoria: cat.nombre,
        disponible: esDisp,
        unidad: unidad,
        codigoPLU: codPLU
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
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">No hay productos registrados.</td></tr>`;
    return;
  }

  let html = "";
  lista.forEach((item, idx) => {
    let safeName = item.nombre.replace(/["']/g, '');
    let unidadTxt = (item.unidad === 'gramos') ? 'g' : (item.unidad === 'mixto' ? 'mixto' : 'uds');

    html += `
      <tr>
        <td class="text-center">
          <input type="text" class="form-control form-control-sm text-center fw-bold border-dark text-primary input-codigo-plu-item" 
                 data-nombre="${safeName}" 
                 data-cat="${item.categoria}" 
                 value="${item.codigoPLU}" 
                 placeholder="Sin código" style="max-width: 120px; margin: 0 auto;">
        </td>
        <td class="fw-bold text-dark">${item.nombre}</td>
        <td class="small text-muted">${item.categoria}</td>
        <td class="text-center">
          <select class="form-select form-select-sm border-dark fw-bold select-disp-item" data-nombre="${safeName}" style="max-width: 140px; margin: 0 auto;">
            <option value="true" ${item.disponible ? 'selected' : ''}>✅ Disponible</option>
            <option value="false" ${!item.disponible ? 'selected' : ''}>🚫 Agotado</option>
          </select>
        </td>
        <td class="text-center"><span class="badge bg-light text-dark border">${unidadTxt}</span></td>
        <td class="text-center">
          <input type="number" step="0.01" min="0.01" class="form-control form-control-sm text-center fw-bold border-dark text-success input-precio-item" 
                 data-nombre="${safeName}" 
                 data-cat="${item.categoria}" 
                 value="${item.precio.toFixed(2)}" style="max-width: 110px; margin: 0 auto;">
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

function guardarTodosLosCodigosPLU() {
  const input = document.getElementById('inputTokenQR');
  if (input) input.value = "";
  
  document.getElementById('errorModalTokenQR').classList.add('hidden');
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalEscanearTokenGitHub')).show();

  setTimeout(() => {
    if (input) input.focus();
  }, 400);
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
  procesarSincronizacionGitHub();
}

async function procesarSincronizacionGitHub() {
  const btn = document.getElementById('btnGuardarCodigosPLU');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sincronizando con GitHub...";
  }

  try {
    const inputsPLU = document.querySelectorAll('.input-codigo-plu-item');
    const selectsDisp = document.querySelectorAll('.select-disp-item');
    const inputsPrecio = document.querySelectorAll('.input-precio-item');

    let mapaNuevosCodigos = {};
    let mapaDisponibilidad = {};
    let mapaPrecios = {};

    inputsPLU.forEach(inp => {
      let nombreProd = inp.getAttribute('data-nombre');
      let nuevoCod = inp.value.trim();
      mapaNuevosCodigos[nombreProd] = nuevoCod;
    });

    selectsDisp.forEach(sel => {
      let nombreProd = sel.getAttribute('data-nombre');
      let esDisp = (sel.value === "true");
      mapaDisponibilidad[nombreProd] = esDisp;
    });

    inputsPrecio.forEach(inp => {
      let nombreProd = inp.getAttribute('data-nombre');
      let nuevoPrec = parseFloat(inp.value);
      if (!isNaN(nuevoPrec) && nuevoPrec > 0) {
        mapaPrecios[nombreProd] = nuevoPrec;
      }
    });

    cacheCategoriasFactura.forEach(cat => {
      cat.productos.forEach(p => {
        let nom = p[0];
        if (mapaPrecios[nom] !== undefined) {
          p[1] = mapaPrecios[nom];
        }
        if (mapaDisponibilidad[nom] !== undefined) {
          p[3] = mapaDisponibilidad[nom];
        }
        if (mapaNuevosCodigos[nom] !== undefined) {
          p[7] = mapaNuevosCodigos[nom];
        }
      });
    });

    const contentString = JSON.stringify({ categorias: cacheCategoriasFactura }, null, 2);
    const base64Content = btoa(unescape(encodeURIComponent(contentString)));

    await subirArchivoAGitHubFactura("catalog.json", base64Content, "Actualización de precios, códigos PLU y disponibilidad desde Módulo de Facturación");

    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Guardar Todos los Cambios";
    }

    renderizarCatalogoFacturacion({ categorias: cacheCategoriasFactura });

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalGestionCodigos')).hide();
    mostrarAvisoFactura("🎉 Configuración de productos, precios y disponibilidad guardada con éxito.");

  } catch (err) {
    sessionStorage.removeItem("github_token");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 Guardar Todos los Cambios";
    }
    console.error("Error al guardar en GitHub:", err);
    mostrarAvisoFactura("❌ Error de clave/sincronización con GitHub: " + err.message + ". Escanee nuevamente.");
  }
}

async function subirArchivoAGitHubFactura(path, contentBase64, commitMessage) {
  const token = sessionStorage.getItem("github_token");
  if (!token) throw new Error("Token de GitHub no disponible.");

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
    throw new Error(errData.message || "Fallo en la comunicación con GitHub.");
  }
  return await response.json();
}

// BÚSQUEDA Y HISTORIAL DE FACTURAS EN SUPABASE E INDEXEDDB (COLUMNAS EXACTAS)
function abrirModalBuscarFacturas() {
  document.getElementById('facBusquedaInput').value = "";
  buscarFacturasHistorial('ultimas10');
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalBuscarFacturas')).show();
}

async function buscarFacturasHistorial(modo) {
  const inputVal = document.getElementById('facBusquedaInput').value.trim().toUpperCase();
  const tbody = document.getElementById('tablaHistorialFacturas');
  
  if (modo === 'busqueda' && !inputVal) {
    return mostrarAvisoFactura("Ingrese Cédula, RIF o N° de Factura a buscar.");
  }

  let ventasLocales = await dbGetAll("ventas");
  let resultadosLocales = [];

  if (modo === 'ultimas10') {
    resultadosLocales = ventasLocales.slice(-10).reverse();
  } else if (inputVal) {
    resultadosLocales = ventasLocales.filter(v => {
      return (v.numFactura && String(v.numFactura).toUpperCase().includes(inputVal)) ||
             (v.cedula && String(v.cedula).toUpperCase().includes(inputVal)) ||
             (v.nombre && String(v.nombre).toUpperCase().includes(inputVal));
    }).reverse().slice(0, 200);
  }

  cacheHistorialFacturas = resultadosLocales;
  renderizarTablaHistorialFacturas();

  if (resultadosLocales.length === 0 && tbody) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">⏳ Consultando facturas en Supabase...</td></tr>`;
  }

  if (navigator.onLine) {
    try {
      let query = supabaseClient.from('ventas').select('*');

      if (modo === 'ultimas10') {
        query = query.order('FACTURA N°', { ascending: false }).limit(10);
      } else if (inputVal) {
        query = query.or(`"FACTURA N°".ilike.%${inputVal}%,"CEDULA O RIF".ilike.%${inputVal}%,"NOMBRE / RAZON SOCIAL".ilike.%${inputVal}%`).limit(200);
      }

      const { data: ventasSup, error } = await query;

      if (!error && ventasSup) {
        const mapFacturas = {};
        ventasSup.forEach(v => {
          mapFacturas[v["FACTURA N°"]] = {
            numFactura: v["FACTURA N°"],
            fechaStr: v["FECHA"] || "",
            cedula: v["CEDULA O RIF"] || "",
            nombre: v["NOMBRE / RAZON SOCIAL"] || "",
            direccion: v["UBICACION"] || "",
            productosSummary: v["PRODUCTOS"] || "",
            formaPagoStr: v["FORMA DE PAGO"] || "",
            montoTotalUSD: parseFloat(v["MONTO TOTAL"]) || 0
          };
        });
        resultadosLocales.forEach(f => { mapFacturas[f.numFactura] = f; });

        cacheHistorialFacturas = Object.values(mapFacturas).sort((a, b) => {
          let numA = a.numFactura ? parseInt(String(a.numFactura).replace(/\D/g, ''), 10) : 0;
          let numB = b.numFactura ? parseInt(String(b.numFactura).replace(/\D/g, ''), 10) : 0;
          return numB - numA;
        }).slice(0, 200);

        for (let f of cacheHistorialFacturas) {
          await dbPut("ventas", f);
        }
        renderizarTablaHistorialFacturas();
      }
    } catch (err) {
      console.warn("Aviso consulta historial Supabase:", err);
    }
  }
}

function renderizarTablaHistorialFacturas() {
  const tbody = document.getElementById('tablaHistorialFacturas');
  if (!tbody) return;

  if (cacheHistorialFacturas.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">No se encontraron facturas registradas.</td></tr>`;
    return;
  }

  let html = "";
  cacheHistorialFacturas.forEach(f => {
    html += `
      <tr>
        <td class="fw-bold text-center text-danger">${f.numFactura}</td>
        <td class="text-center small">${f.fechaStr}</td>
        <td class="fw-bold text-center">${f.cedula}</td>
        <td class="fw-bold text-wrap">${f.nombre}</td>
        <td class="small text-muted">${f.formaPagoStr}</td>
        <td class="text-end fw-bold text-success">$${parseFloat(f.montoTotalUSD).toFixed(2)}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-primary py-0 px-2 fw-bold me-1" onclick="reimprimirFacturaHistorial('${f.numFactura}')" title="Reimprimir Ticket">
            🖨️ Imprimir
          </button>
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fw-bold" onclick="eliminarFacturaHistorial('${f.numFactura}')" title="Eliminar Factura">
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
  const totalBs = totalUSD * tasa;

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
    productosSummary: fac.productosSummary
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
        <div><strong>FACTURA N°:</strong> <span class="fs-6">${d.numFactura}</span> (COPIA)</div>
        <div><strong>FECHA:</strong> ${d.fechaStr}</div>
        <div><strong>CLIENTE:</strong> ${d.cliente.nombre}</div>
        <div><strong>CI/RIF:</strong> ${d.cliente.cedula}</div>
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
          <strong class="fs-6">$${d.totalUSD.toFixed(2)}</strong>
        </div>
        <div class="d-flex justify-content-between text-muted">
          <span>TOTAL FACTURA (Bs):</span>
          <span>Bs. ${d.totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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

  await dbDelete("ventas", numFactura);
  cacheHistorialFacturas = cacheHistorialFacturas.filter(f => f.numFactura !== numFactura);
  renderizarTablaHistorialFacturas();

  await dbPut("syncQueue", {
    id: "sync_del_fac_" + Date.now(),
    payload: { action: "eliminarFactura", numFactura: numFactura }
  });

  mostrarAvisoFactura(`🗑️ Factura ${numFactura} eliminada.`);
  procesarColaSincronizacion();
}

// DESCARGA DE REGISTRO EN EXCEL (.XLSX) DESDE SUPABASE
function abrirModalFiltroDescarga() {
  const inputFecha = document.getElementById('descargaFechaInput');
  const selectForma = document.getElementById('descargaFormaPagoSelect');
  const errorDiv = document.getElementById('errorModalDescarga');

  if (inputFecha) {
    const hoy = new Date().toISOString().split('T')[0];
    inputFecha.value = hoy;
  }
  if (selectForma) selectForma.value = "TODOS";
  if (errorDiv) errorDiv.classList.add('hidden');

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFiltroDescarga')).show();
}

async function ejecutarDescargaExcelFacturas() {
  const fechaVal = document.getElementById('descargaFechaInput').value;
  const formaPagoVal = document.getElementById('descargaFormaPagoSelect').value;
  const errorDiv = document.getElementById('errorModalDescarga');
  const btn = document.getElementById('btnProcesarDescargaExcel');

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

    let query = supabaseClient.from('ventas').select('*');

    if (formaPagoVal !== "TODOS" && formaPagoVal !== "") {
      if (formaPagoVal === "Cashea") {
        query = query.ilike('FORMA DE PAGO', '%CASHEA%');
      } else if (formaPagoVal === "Pago Mixto") {
        query = query.or('"FORMA DE PAGO".ilike.%MIXTO%,"FORMA DE PAGO".ilike.%+%');
      } else {
        query = query.ilike('FORMA DE PAGO', `%${formaPagoVal}%`);
      }
    }

    const { data: todosRegistros, error } = await query;

    btn.disabled = false;
    btn.textContent = "📊 Descargar Excel (.xlsx)";

    if (!error && todosRegistros && todosRegistros.length > 0) {
      const registrosFiltrados = todosRegistros.filter(r => {
        const fStr = String(r["FECHA"] || "");
        return fStr.includes(patronFecha1) || fStr.includes(patronFecha2) || fStr.startsWith(fechaVal);
      });

      if (registrosFiltrados.length === 0) {
        if (errorDiv) {
          errorDiv.textContent = "No se encontraron ventas registradas para la fecha indicada.";
          errorDiv.classList.remove('hidden');
        }
        return;
      }

      const filasExcel = registrosFiltrados.map(r => ({
        "Fecha / Hora": r["FECHA"] || "",
        "Factura N°": r["FACTURA N°"] || "",
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
        "Punto de Venta (Bs)": parseFloat(r["PUNTO DE VENTA"]) || 0,
        "Transferencia (Bs)": parseFloat(r["TRANSFERENCIA"]) || 0,
        "Biopago (Bs)": parseFloat(r["BIOPAGO"]) || 0
      }));

      const worksheet = XLSX.utils.json_to_sheet(filasExcel);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Facturas");

      const maxCols = Object.keys(filasExcel[0]).map(key => ({
        wch: Math.max(key.length, ...filasExcel.map(r => String(r[key] || "").length)) + 2
      }));
      worksheet['!cols'] = maxCols;

      const nombreArchivo = `Reporte_Facturas_${fechaVal}_${formaPagoVal.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
      XLSX.writeFile(workbook, nombreArchivo);

      bootstrap.Modal.getOrCreateInstance(document.getElementById('modalFiltroDescarga')).hide();
      mostrarAvisoFactura("🎉 Reporte Excel generado y descargado exitosamente.");

    } else {
      if (errorDiv) {
        errorDiv.textContent = "No se encontraron registros de ventas para la fecha y método seleccionados.";
        errorDiv.classList.remove('hidden');
      } else {
        mostrarAvisoFactura("No se encontraron registros de ventas para los criterios seleccionados.");
      }
    }

  } catch (err) {
    btn.disabled = false;
    btn.textContent = "📊 Descargar Excel (.xlsx)";
    console.error("Error al descargar reporte Excel:", err);
    if (errorDiv) {
      errorDiv.textContent = "Error de conexión al obtener el reporte Excel.";
      errorDiv.classList.remove('hidden');
    }
  }
}

// MOVIMIENTOS DE EFECTIVO PERSISTENTES
function cargarMovimientosEfectivoPersistentes() {
  const hoy = new Date().toISOString().split('T')[0];
  const guardado = localStorage.getItem("movimientos_efectivo_" + hoy);
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
      errorDiv.textContent = "Por favor, complete todos los campos requeridos del Formulario de Vale de Caja.";
      errorDiv.classList.remove('hidden');
      return;
    }

    conceptoFinal = `VALE DE CAJA: ${empNombre} (CI: ${empCedula}) - ${motivoVal} [${cuotasVal} CUOTA(S)] - AUT: ${autPor}`;

    datosVale = {
      fechaHora: new Date().toLocaleString('es-VE'),
      empleadoNombre: empNombre,
      empleadoCedula: empCedula,
      motivo: motivoVal,
      monto: monto,
      moneda: moneda,
      cuotas: cuotasVal,
      autorizadoPor: autPor
    };

  } else {
    conceptoFinal = document.getElementById('movConceptoInput').value.trim().toUpperCase();
    if (!conceptoFinal) {
      errorDiv.textContent = "Por favor, especifique el concepto o motivo del movimiento.";
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
    concepto: conceptoFinal
  };

  listaMovimientosEfectivo.push(nuevoMov);
  await dbPut("movimientos", nuevoMov);

  const hoy = new Date().toISOString().split('T')[0];
  localStorage.setItem("movimientos_efectivo_" + hoy, JSON.stringify(listaMovimientosEfectivo));

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
    mostrarAvisoFactura(`🎟️ Vale de Caja para ${datosVale.empleadoNombre} registrado e impreso exitosamente.`);
  } else {
    mostrarAvisoFactura(`💸 Movimiento de ${tipo} (${moneda}) registrado exitosamente.`);
  }
}

function renderizarTicketValeCajaHTML(d) {
  let montoTxt = (d.moneda === "BS")
    ? `Bs. ${d.monto.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${d.monto.toFixed(2)}`;

  const ticketHtml = `
    <div class="ticket-container shadow-sm border text-start">
      <div class="ticket-header">
        <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
        <div class="ticket-title fs-6">VALE DE CAJA - EGRESO</div>
        <div>RIF: J-505072889 | TELF: 0412-1753275</div>
        <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
      </div>

      <div class="ticket-info">
        <div><strong>FECHA Y HORA:</strong> ${d.fechaHora}</div>
        <div><strong>CONCEPTO:</strong> ADELANTO DE SUELDO</div>
      </div>

      <div class="ticket-box-info">
        <div><strong>EMPLEADO:</strong> ${d.empleadoNombre}</div>
        <div><strong>CÉDULA / CI:</strong> ${d.empleadoCedula}</div>
        <div><strong>MOTIVO:</strong> ${d.motivo}</div>
        <div><strong>MONTO DEL VALE:</strong> <span class="fs-6 font-weight-bold">${montoTxt}</span></div>
        <div><strong>CUOTAS A DESCONTAR:</strong> ${d.cuotas} cuota(s)</div>
        <div><strong>AUTORIZADO POR:</strong> ${d.autorizadoPor}</div>
      </div>

      <div class="small text-muted text-justify mt-2 mb-3" style="font-size: 8.5px; line-height: 1.2;">
        Conste por la presente la recepción conforme del dinero arriba indicado y la expresa autorización para descontar dicho monto en la(s) cuota(s) establecida(s).
      </div>

      <div class="ticket-firma-linea">
        ____________________________________<br>
        FIRMA Y CONFORMIDAD EMPLEADO<br>
        CI: ${d.empleadoCedula}
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
        <td class="text-center small">${m.hora}</td>
        <td class="text-center">${badgeTipo}</td>
        <td class="text-center fw-bold">${m.moneda}</td>
        <td class="text-end fw-bold ${esIngreso ? 'text-success' : 'text-danger'}">${montoTxt}</td>
        <td class="small text-wrap">${m.concepto}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fw-bold" onclick="eliminarMovimientoEfectivo(${idx})" title="Eliminar movimiento">
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
    localStorage.setItem("movimientos_efectivo_" + hoy, JSON.stringify(listaMovimientosEfectivo));

    renderizarTablaMovimientosDia();
    mostrarAvisoFactura(`🗑️ Movimiento de ${mov.tipo} (${mov.moneda}) eliminado.`);
  }
}

// CIERRE DE CAJA (REPORTE Z) E HISTORIAL EN SUPABASE
function abrirModalCierreCaja() {
  const usuario = sessionStorage.getItem("factura_usuario") || "CAJERO";
  document.getElementById('cierreUsuarioNombre').textContent = `👤 Cajero: ${usuario.toUpperCase()}`;
  document.getElementById('cierreInicialUSD').value = "0.00";
  document.getElementById('cierreInicialBS').value = "0.00";
  document.getElementById('errorModalCierrePaso1').classList.add('hidden');

  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCierreCajaPaso1')).show();
}

function abrirModalHistorialCierres() {
  cargarHistorialCierresCaja();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modalHistorialCierres')).show();
}

async function cargarHistorialCierresCaja() {
  const tbody = document.getElementById('tablaHistorialCierresCaja');
  if (!tbody) return;

  let cierresLocales = await dbGetAll("cierres");
  if (cierresLocales.length > 0) {
    cacheHistorialCierres = cierresLocales.reverse();
    renderizarTablaHistorialCierres();
  } else {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">⏳ Consultando cierres de caja...</td></tr>`;
  }

  if (navigator.onLine) {
    try {
      const { data: cierresSup, error } = await supabaseClient.from('cierres').select('*').order('id', { ascending: false }).limit(50);
      if (!error && cierresSup) {
        cacheHistorialCierres = cierresSup.map(c => ({
          fechaStr: c["FECHA"] || "",
          usuario: c["USUARIO"] || "",
          inicialUSD: parseFloat(c["INICIAL $"]) || 0,
          inicialBS: parseFloat(c["INICIAL Bs"]) || 0,
          cajaFinalUSD: parseFloat(c["TOTAL 3"]) || 0,
          cajaFinalBS: parseFloat(c["TOTAL 4"]) || 0,
          totalVentasUSD: parseFloat(c["TOTAL 1"]) || 0,
          totalVentasBS: parseFloat(c["TOTAL 2"]) || 0,
          resumen: {
            ventasEfectivoUSD: parseFloat(c["DIVISAS"]) || 0,
            ventasEfectivoBS: parseFloat(c["BOLIVARES"]) || 0,
            ventasPagoMovil: parseFloat(c["PAGO MOVIL"]) || 0,
            ventasZelle: parseFloat(c["ZELLE"]) || 0,
            ventasPayPal: parseFloat(c["PAYPAL"]) || 0,
            ventasPuntoVenta: parseFloat(c["PUNTO DE VENTA"]) || 0,
            ventasBiopago: parseFloat(c["BIOPAGO"]) || 0,
            ventasCashea: parseFloat(c["CASHEA"]) || 0,
            ventasTransferencia: parseFloat(c["TRANSFERECIA"]) || 0,
            totalGeneralVentasUSD: parseFloat(c["TOTAL 1"]) || 0,
            totalGeneralVentasBS: parseFloat(c["TOTAL 2"]) || 0
          }
        }));
        for (let c of cacheHistorialCierres) {
          await dbPut("cierres", c);
        }
        renderizarTablaHistorialCierres();
      }
    } catch (e) {}
  }
}

function renderizarTablaHistorialCierres() {
  const tbody = document.getElementById('tablaHistorialCierresCaja');
  if (!tbody) return;

  if (cacheHistorialCierres.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-4">No hay cierres de caja registrados.</td></tr>`;
    return;
  }

  let html = "";
  cacheHistorialCierres.forEach((c, idx) => {
    html += `
      <tr>
        <td class="fw-bold text-center small">${c.fechaStr}</td>
        <td class="fw-bold text-center">${c.usuario}</td>
        <td class="text-center small">$${c.inicialUSD.toFixed(2)} / Bs.${c.inicialBS.toLocaleString('es-VE', {minimumFractionDigits:2})}</td>
        <td class="text-center small">$${c.totalVentasUSD.toFixed(2)} / Bs.${c.totalVentasBS.toLocaleString('es-VE', {minimumFractionDigits:2})}</td>
        <td class="text-center fw-bold text-success">$${c.cajaFinalUSD.toFixed(2)} / Bs.${c.cajaFinalBS.toLocaleString('es-VE', {minimumFractionDigits:2})}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-primary py-0 px-2 fw-bold" onclick="reimprimirCierreCajaHistorial(${idx})" title="Reimprimir Reporte Z">
            🖨️ Reimprimir
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
    fechaStr: c.fechaStr,
    usuario: c.usuario,
    tasaBCV: c.tasaBCV || obtenerTasaBCV(),
    inicialUSD: c.inicialUSD,
    inicialBS: c.inicialBS,
    resumen: c.resumen,
    ingresosUSD: 0,
    retirosUSD: 0,
    ingresosBS: 0,
    retirosBS: 0,
    totalCajaUSD: c.cajaFinalUSD,
    totalCajaBS: c.cajaFinalBS
  };

  renderizarTicketCierreCajaHTML(datosCierreCajaPendiente);
  const ticketHtml = document.getElementById('contenidoTicketImprimible').innerHTML;
  ejecutarImpresionTicket(ticketHtml);
  mostrarAvisoFactura(`🖨️ Reimprimiendo Reporte Z del ${c.fechaStr}...`);
}

async function procesarSiguienteCierreCaja() {
  const inicialUSD = parseFloat(document.getElementById('cierreInicialUSD').value) || 0;
  const inicialBS = parseFloat(document.getElementById('cierreInicialBS').value) || 0;
  const btn = document.getElementById('btnSiguienteCierreCaja');

  btn.disabled = true;
  btn.textContent = "Consultando ventas...";

  try {
    let resumen = {
      ventasEfectivoUSD: 0, ventasEfectivoBS: 0, ventasPagoMovil: 0,
      ventasZelle: 0, ventasPayPal: 0, ventasCashea: 0,
      ventasPuntoVenta: 0, ventasTransferencia: 0, ventasBiopago: 0,
      totalGeneralVentasUSD: 0, totalGeneralVentasBS: 0
    };

    if (navigator.onLine) {
      try {
        const [ano, mes, dia] = new Date().toISOString().split('T')[0].split('-');
        const patron1 = `${dia}/${mes}/${ano}`;
        const patron2 = `${parseInt(dia, 10)}/${parseInt(mes, 10)}/${ano}`;

        const { data: ventasHoy, error } = await supabaseClient.from('ventas').select('*');

        if (!error && ventasHoy) {
          ventasHoy.forEach(v => {
            const fStr = String(v["FECHA"] || "");
            if (fStr.includes(patron1) || fStr.includes(patron2)) {
              resumen.ventasEfectivoUSD += parseFloat(v["EFECTIVO DIVISAS"]) || 0;
              resumen.ventasEfectivoBS += parseFloat(v["EFECTIVO BOLIVARES"]) || 0;
              resumen.ventasPagoMovil += parseFloat(v["PAGO MOVIL"]) || 0;
              resumen.ventasZelle += parseFloat(v["ZELLE"]) || 0;
              resumen.ventasPayPal += parseFloat(v["PAYPAL"]) || 0;
              resumen.ventasCashea += parseFloat(v["CASHEA"]) || 0;
              resumen.ventasPuntoVenta += parseFloat(v["PUNTO DE VENTA"]) || 0;
              resumen.ventasTransferencia += parseFloat(v["TRANSFERENCIA"]) || 0;
              resumen.ventasBiopago += parseFloat(v["BIOPAGO"]) || 0;
            }
          });
        }
      } catch (e) {}
    } else {
      const ventasLocales = await dbGetAll("ventas");
      ventasLocales.forEach(v => {
        resumen.ventasEfectivoUSD += parseFloat(v.montoTotalUSD) || 0;
      });
    }

    btn.disabled = false;
    btn.textContent = "Siguiente ➡️";

    const usuario = sessionStorage.getItem("factura_usuario") || "CAJERO";
    const tasa = obtenerTasaBCV();

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

    resumen.totalGeneralVentasUSD = resumen.ventasEfectivoUSD + resumen.ventasZelle + resumen.ventasPayPal + resumen.ventasCashea;
    resumen.totalGeneralVentasBS = resumen.ventasEfectivoBS + resumen.ventasPagoMovil + resumen.ventasPuntoVenta + resumen.ventasBiopago + resumen.ventasTransferencia;

    const totalCajaUSD = inicialUSD + resumen.ventasEfectivoUSD + ingresosUSD - retirosUSD;
    const totalCajaBS = inicialBS + resumen.ventasEfectivoBS + ingresosBS - retirosBS;

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
      resumen: resumen,
      totalCajaUSD: totalCajaUSD,
      totalCajaBS: totalCajaBS
    };

    renderizarTicketCierreCajaHTML(datosCierreCajaPendiente);

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
  const r = d.resumen || {};

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
            <td class="text-end fw-bold text-success">+$${d.ingresosUSD.toFixed(2)}</td>
          </tr>
          <tr>
            <td>RETIROS DE EFECTIVO DIVISAS (-):</td>
            <td class="text-end fw-bold text-danger">-$${d.retirosUSD.toFixed(2)}</td>
          </tr>
          <tr>
            <td>INGRESOS DE EFECTIVO BOLÍVARES (+):</td>
            <td class="text-end fw-bold text-success">+Bs. ${d.ingresosBS.toLocaleString('es-VE', { minimumFractionDigits: 2 })}</td>
          </tr>
          <tr>
            <td>RETIROS DE EFECTIVO BOLÍVARES (-):</td>
            <td class="text-end fw-bold text-danger">-Bs. ${d.retirosBS.toLocaleString('es-VE', { minimumFractionDigits: 2 })}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  const ticketHtml = `
    <div class="ticket-container shadow-sm border text-start">
      <div class="ticket-header">
        <img src="../img/LOGO-MUNDO123.webp" class="ticket-logo-centrado" alt="Logo Mundocarnes">
        <div class="ticket-title fs-6">COMPROBANTE DE CIERRE DE CAJA</div>
        <div>RIF: J-505072889 | TELF: 0412-1753275</div>
        <div>Caracas, Dtto Capital, San Juan, Av. San Martín</div>
      </div>

      <div class="ticket-info">
        <div><strong>FECHA / HORA:</strong> ${d.fechaStr}</div>
        <div><strong>CAJERO(A):</strong> ${d.usuario}</div>
        <div><strong>TASA BCV:</strong> Bs. ${d.tasaBCV.toFixed(2)}</div>
      </div>

      <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
        1. INICIO DE JORNADA (SALDO INICIAL)
      </div>
      <table class="ticket-table mb-2">
        <tbody>
          <tr>
            <td>EFECTIVO INICIAL DIVISAS:</td>
            <td class="text-end fw-bold">$${d.inicialUSD.toFixed(2)}</td>
          </tr>
          <tr>
            <td>EFECTIVO INICIAL BOLÍVARES:</td>
            <td class="text-end fw-bold">Bs. ${d.inicialBS.toLocaleString('es-VE', { minimumFractionDigits: 2 })}</td>
          </tr>
        </tbody>
      </table>

      <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
        2. INGRESOS DEL DÍA (VENTAS)
      </div>
      <table class="ticket-table mb-2">
        <tbody>
          <tr>
            <td>EFECTIVO DIVISAS:</td>
            <td class="text-end fw-bold">$${r.ventasEfectivoUSD ? r.ventasEfectivoUSD.toFixed(2) : '0.00'}</td>
          </tr>
          <tr>
            <td>EFECTIVO BOLÍVARES:</td>
            <td class="text-end fw-bold">Bs. ${r.ventasEfectivoBS ? r.ventasEfectivoBS.toLocaleString('es-VE', { minimumFractionDigits: 2 }) : '0.00'}</td>
          </tr>
          <tr>
            <td>PAGO MÓVIL:</td>
            <td class="text-end fw-bold">Bs. ${r.ventasPagoMovil ? r.ventasPagoMovil.toLocaleString('es-VE', { minimumFractionDigits: 2 }) : '0.00'}</td>
          </tr>
          <tr>
            <td>ZELLE:</td>
            <td class="text-end fw-bold">$${r.ventasZelle ? r.ventasZelle.toFixed(2) : '0.00'}</td>
          </tr>
          <tr>
            <td>PAYPAL:</td>
            <td class="text-end fw-bold">$${r.ventasPayPal ? r.ventasPayPal.toFixed(2) : '0.00'}</td>
          </tr>
          <tr>
            <td>PUNTO DE VENTA:</td>
            <td class="text-end fw-bold">Bs. ${r.ventasPuntoVenta ? r.ventasPuntoVenta.toLocaleString('es-VE', { minimumFractionDigits: 2 }) : '0.00'}</td>
          </tr>
          <tr>
            <td>BIOPAGO:</td>
            <td class="text-end fw-bold">Bs. ${r.ventasBiopago ? r.ventasBiopago.toLocaleString('es-VE', { minimumFractionDigits: 2 }) : '0.00'}</td>
          </tr>
          <tr>
            <td>CASHEA:</td>
            <td class="text-end fw-bold">$${r.ventasCashea ? r.ventasCashea.toFixed(2) : '0.00'}</td>
          </tr>
          <tr>
            <td>TRANSFERENCIA BANCARIA:</td>
            <td class="text-end fw-bold">Bs. ${r.ventasTransferencia ? r.ventasTransferencia.toLocaleString('es-VE', { minimumFractionDigits: 2 }) : '0.00'}</td>
          </tr>
        </tbody>
      </table>

      ${seccionMovimientosHtml}

      <div class="fw-bold border-bottom pb-1 mb-1 text-center bg-light">
        4. TOTALES GENERALES Y BALANCE CAJA
      </div>
      <div class="ticket-totals border-top pt-1">
        <div class="d-flex justify-content-between">
          <span>TOTAL VENTAS INGRESOS ($):</span>
          <strong class="fs-6">$${r.totalGeneralVentasUSD ? r.totalGeneralVentasUSD.toFixed(2) : '0.00'}</strong>
        </div>
        <div class="d-flex justify-content-between">
          <span>TOTAL VENTAS INGRESOS (Bs):</span>
          <strong class="fs-6">Bs. ${r.totalGeneralVentasBS ? r.totalGeneralVentasBS.toLocaleString('es-VE', { minimumFractionDigits: 2 }) : '0.00'}</strong>
        </div>
        <div class="ticket-divider"></div>
        <div class="d-flex justify-content-between text-success fw-bold">
          <span>EFECTIVO FINAL EN CAJA ($):</span>
          <span class="fs-6">$${d.totalCajaUSD.toFixed(2)}</span>
        </div>
        <div class="d-flex justify-content-between text-primary fw-bold">
          <span>EFECTIVO FINAL EN CAJA (Bs):</span>
          <span class="fs-6">Bs. ${d.totalCajaBS.toLocaleString('es-VE', { minimumFractionDigits: 2 })}</span>
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
    await dbPut("cierres", datosCierreCajaPendiente);

    await dbPut("syncQueue", {
      id: "sync_cie_" + Date.now(),
      payload: { action: "guardarCierreCaja", datosCierre: datosCierreCajaPendiente }
    });

    const ticketHtml = document.getElementById('vistaPreviaCierreCajaModal').innerHTML;
    ejecutarImpresionTicket(ticketHtml);

    if (btn) { btn.disabled = false; btn.textContent = "🔒 Realizar Cierre"; }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('modalCierreCajaPaso2')).hide();
    datosCierreCajaPendiente = null;

    const hoy = new Date().toISOString().split('T')[0];
    localStorage.removeItem("movimientos_efectivo_" + hoy);
    listaMovimientosEfectivo = [];

    mostrarAvisoFactura("🔒 Cierre de caja registrado e impreso exitosamente. 🎉");

    procesarColaSincronizacion();

  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = "🔒 Realizar Cierre"; }
    console.error("Error al guardar cierre local:", err);
    mostrarAvisoFactura("Error al registrar el cierre de caja localmente.");
  }
}

// OYENTES DE EVENTOS DE RED
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: '/factura/' })
      .then(reg => console.log('App de Ventas Offline-First lista para instalar:', reg.scope))
      .catch(err => console.error('Error PWA Ventas:', err));
  }
});
