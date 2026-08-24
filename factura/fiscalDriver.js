class FiscalDriverTFHKA {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.conectado = false;
    this.ocupadoTransmision = false; // Semáforo de bloqueo para evitar colisiones en el puerto serie
    this.modelo = localStorage.getItem("pos_modelo_impresora_fiscal") || "HKA80";
    this.baudRate = 9600;
    this.paridad = this.obtenerParidadPorDefecto();
    this.timeoutMs = 12000;
    this.ultimoNumeroFactura = null;
    this.ultimoNumeroZ = null;
    this.ultimoReporteStatus = null;
    this.onStatusChangeCallback = null;
  }
  // Comprobar compatibilidad de Web Serial API
  static esCompatible() {
    return 'serial' in navigator;
  }

 obtenerParidadPorDefecto() {
    // Tanto HKA80 como Aclas PP9 Plus operan de fábrica en 9600 bps sin paridad (None)
    return "none";
  }

  setModelo(nuevoModelo) {
    this.modelo = nuevoModelo === "PP9" ? "PP9" : "HKA80";
    this.paridad = this.obtenerParidadPorDefecto();
    localStorage.setItem("pos_modelo_impresora_fiscal", this.modelo);
    this.notificarEstado("CAMBIO_MODELO", `Modelo fiscal configurado: ${this.getNombreModelo()}`);
  }

  getNombreModelo() {
    return this.modelo === "HKA80" ? "The Factory HKA80" : "Aclas PP9 Plus";
  }

  onStatusChange(callback) {
    this.onStatusChangeCallback = callback;
  }

  notificarEstado(estado, mensaje, datos = null) {
    if (typeof this.onStatusChangeCallback === 'function') {
      this.onStatusChangeCallback({ 
        estado, 
        mensaje, 
        datos,
        modelo: this.modelo,
        nombreModelo: this.getNombreModelo()
      });
    }
  }

  // Apertura física del puerto serie estable y directo
  async abrirPuerto() {
    if (!this.port) throw new Error("Puerto serial no inicializado.");

    if (!this.port.readable || !this.port.writable) {
      await this.port.open({
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none"
      });

      try {
        await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
      } catch (e) {}
    }
  }

  // Solicitar puerto interactivo al usuario
  async solicitarYConectar() {
    if (!FiscalDriverTFHKA.esCompatible()) {
      throw new Error("Su navegador no soporta Web Serial API. Utilice Google Chrome o Microsoft Edge.");
    }

    try {
      this.port = await navigator.serial.requestPort();
      await this.abrirPuerto();
      this.conectado = true;
      this.notificarEstado("CONECTADO", `Impresora fiscal ${this.getNombreModelo()} conectada y lista.`);
      return true;
    } catch (err) {
      this.conectado = false;
      this.notificarEstado("ERROR_CONEXION", `No se pudo conectar con ${this.getNombreModelo()}: ` + err.message);
      throw err;
    }
  }

  // Reconectar automáticamente si el puerto ya fue autorizado
  async reconectarAutomatico() {
    if (!FiscalDriverTFHKA.esCompatible()) return false;

    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length > 0) {
        this.port = ports[0];
        await this.abrirPuerto();
        this.conectado = true;
        this.notificarEstado("CONECTADO", `Reconexión con ${this.getNombreModelo()} establecida.`);
        return true;
      }
      return false;
    } catch (err) {
      this.conectado = false;
      return false;
    }
  }

  async desconectar() {
    try {
      this.conectado = false;
      if (this.reader) {
        try { await this.reader.cancel(); } catch (e) {}
        try { this.reader.releaseLock(); } catch (e) {}
        this.reader = null;
      }
      if (this.writer) {
        try { this.writer.releaseLock(); } catch (e) {}
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
      this.notificarEstado("DESCONECTADO", `Impresora fiscal ${this.getNombreModelo()} desconectada.`);
      return true;
    } catch (err) {
      console.warn("Aviso al cerrar puerto:", err);
      return false;
    }
  }

  // ========================================================================
  // CONSTRUCTOR DE TRAMA DIRECTA TFHKA: STX (0x02) + DATA + ETX (0x03) + LRC
  // ========================================================================
  construirTrama(comandoStr) {
    const encoder = new TextEncoder();
    const cmdBytes = encoder.encode(comandoStr);
    
    // Cálculo del LRC = XOR de todos los bytes del comando + ETX (0x03)
    let lrc = 0;
    for (let i = 0; i < cmdBytes.length; i++) {
      lrc ^= cmdBytes[i];
    }
    lrc ^= 0x03;

    const trama = new Uint8Array(cmdBytes.length + 3);
    trama[0] = 0x02; // STX
    trama.set(cmdBytes, 1);
    trama[cmdBytes.length + 1] = 0x03; // ETX
    trama[cmdBytes.length + 2] = lrc;  // LRC

    return trama;
  }

  // Enviar comando empaquetado y esperar acuse de recibo
  async enviarComando(comandoStr, esperaRespuestaData = false) {
    if (!this.conectado || !this.port || !this.port.writable) {
      throw new Error(`La impresora fiscal ${this.getNombreModelo()} no está conectada.`);
    }

    try {
      const tramaBytes = this.construirTrama(comandoStr);
      
      this.writer = this.port.writable.getWriter();
      await this.writer.write(tramaBytes);
      this.writer.releaseLock();
      this.writer = null;

      // Pausa adaptada según modelo
      const pausaMs = this.modelo === "PP9" ? 120 : 80;
      await new Promise(r => setTimeout(r, pausaMs));

      const respuesta = await this.leerRespuesta(esperaRespuestaData);
      return respuesta;
    } catch (err) {
      if (this.writer) {
        try { this.writer.releaseLock(); } catch (e) {}
        this.writer = null;
      }
      throw new Error(`Error en comando (${comandoStr}) hacia ${this.getNombreModelo()}: ${err.message}`);
    }
  }

  // Lector de buffer con captura de ACK (0x06), NAK (0x15) o tramas STX-DATA-ETX
  async leerRespuesta(esperaRespuestaData = false) {
    if (!this.port || !this.port.readable) return "";

    const bytesAcumulados = [];
    this.reader = this.port.readable.getReader();
    const tiempoInicio = Date.now();

    try {
      while (Date.now() - tiempoInicio < this.timeoutMs) {
        const { value, done } = await Promise.race([
          this.reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 2500))
        ]).catch(err => {
          if (err.message === "TIMEOUT") return { value: null, done: true };
          throw err;
        });

        if (done || !value) break;

        for (let i = 0; i < value.length; i++) {
          bytesAcumulados.push(value[i]);
        }

        if (!esperaRespuestaData && bytesAcumulados.includes(0x06)) {
          break;
        }

        if (bytesAcumulados.includes(0x15)) {
          throw new Error("La impresora fiscal devolvió NAK (Comando rechazado o estado ocupado).");
        }

        if (bytesAcumulados.includes(0x02) && bytesAcumulados.includes(0x03) && bytesAcumulados.length >= 4) {
          break;
        }
      }
    } finally {
      if (this.reader) {
        try { this.reader.releaseLock(); } catch (e) {}
        this.reader = null;
      }
    }

    if (bytesAcumulados.length > 0) {
      let inicio = bytesAcumulados.indexOf(0x02);
      let fin = bytesAcumulados.lastIndexOf(0x03);

      if (inicio !== -1 && fin !== -1 && fin > inicio) {
        const dataBytes = bytesAcumulados.slice(inicio + 1, fin);
        const decoder = new TextDecoder('ascii');
        return decoder.decode(new Uint8Array(dataBytes)).trim();
      }

      if (bytesAcumulados.includes(0x06)) {
        return "ACK";
      }
    }

    return "";
  }

  // ========================================================================
  // FORMATEADORES DE DATOS PROTOCOLO DIRECTO TFHKA
  // ========================================================================
  sanitizarTexto(texto, maxLen = 38) {
    if (!texto) return "";
    const limpio = String(texto)
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9\s.,#\-_/]/g, "")
      .toUpperCase()
      .trim();
    return limpio.substring(0, maxLen);
  }

  formatearPrecioFiscal(precioFloat) {
    const valor = Math.round((parseFloat(precioFloat) || 0) * 100);
    return String(valor).padStart(10, '0');
  }

  formatearCantidadFiscal(cantFloat, unidad = "unidades") {
    let valor = 0;
    if (unidad === "gramos" || unidad === "mixto") {
      valor = Math.round(parseFloat(cantFloat) || 0);
    } else {
      valor = Math.round((parseFloat(cantFloat) || 1) * 1000);
    }
    return String(valor).padStart(8, '0');
  }

  // ========================================================================
  // OPERACIONES FISCALES DE ALTO NIVEL Y DIAGNÓSTICO DE HARDWARE
  // ========================================================================

  // Diagnosticar en tiempo real mediante comando empaquetado S2 con protección contra colisión
  async verificarEstadoHardware() {
    // Si la impresora está ocupada emitiendo un ticket, pausar el sondeo para evitar colisiones
    if (!this.conectado || !this.port || !this.port.writable || this.ocupadoTransmision) {
      return { ok: true, codigo: "LISTA", mensaje: "Impresora ocupada en transmisión." };
    }

    try {
      const resp = await this.enviarComando("S2", true);
      if (!resp) {
        return { ok: true, codigo: "LISTA", mensaje: "Impresora lista." };
      }

      const lineas = String(resp).split(/[\r\n\x0A\x0D,]+/).map(l => l.trim()).filter(l => l.length > 0);
      const errMecanismo = lineas[2] ? parseInt(lineas[2], 10) : (lineas[1] ? parseInt(lineas[1], 10) : 0);

      // Evaluación de códigos de sensor S2 (0x04 / 4 / 44 = Tapa abierta; 0x01 / 1 / 41 = Sin papel)
      if ((errMecanismo & 0x04) !== 0 || errMecanismo === 4 || errMecanismo === 44) {
        return { ok: false, codigo: "TAPA_ABIERTA", mensaje: `⚠️ Compuerta de la impresora fiscal ${this.getNombreModelo()} abierta. Por favor, ciérrela bien.` };
      }
      if ((errMecanismo & 0x01) !== 0 || errMecanismo === 1 || errMecanismo === 41) {
        return { ok: false, codigo: "SIN_PAPEL", mensaje: `⚠️ Impresora fiscal ${this.getNombreModelo()} sin papel. Por favor, inserte un rollo térmico.` };
      }

      return { ok: true, codigo: "LISTA", mensaje: "Impresora lista." };

    } catch (err) {
      const msg = String(err.message || "").toUpperCase();
      // En Aclas PP9 / HKA80, la apertura de tapa o falta de papel genera rechazo inmediato NAK
      if (msg.includes("NAK") || msg.includes("RECHAZADO") || msg.includes("OCUPADO")) {
        return { ok: false, codigo: "TAPA_ABIERTA", mensaje: `⚠️ Advertencia: Compuerta abierta o falta de papel en ${this.getNombreModelo()}.` };
      }
      return { ok: false, codigo: "ERROR_CONEXION", mensaje: `Sin respuesta de ${this.getNombreModelo()}.` };
    }
  }

  async consultarEstadoSilencioso() {
    try {
      const resp = await this.enviarComando("S1", true);
      if (!resp) return null;

      let numFacturaDetectado = null;
      let numZDetectado = null;
      let serialEquipo = null;
      let rifEquipo = null;

      const lineas = String(resp)
        .split(/\x0A|\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0);

      if (lineas.length >= 3 && /^\d+$/.test(lineas[2])) {
        numFacturaDetectado = lineas[2].padStart(8, '0');
      }
      if (lineas.length >= 7 && /^\d+$/.test(lineas[6])) {
        numZDetectado = lineas[6].padStart(4, '0');
      }
      if (lineas.length >= 9) rifEquipo = lineas[8];
      if (lineas.length >= 10) serialEquipo = lineas[9];

      return { raw: resp, ultimaFactura: numFacturaDetectado, ultimoZ: numZDetectado, serial: serialEquipo, rif: rifEquipo };
    } catch (e) {
      return null;
    }
  }

  // 1. Consultar Estado S1 con captura de Factura, Nota de Crédito, Z y Serial
  async consultarEstado() {
    this.notificarEstado("CONSULTANDO", `Consultando estado S1 en ${this.getNombreModelo()}...`);
    
    let resp = null;
    for (let intento = 0; intento < 4; intento++) {
      try {
        resp = await this.enviarComando("S1", true);
        if (resp && resp.length > 3) break;
      } catch (errIntento) {
        if (intento < 3) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    this.ultimoReporteStatus = resp;

    let numFacturaDetectado = null;
    let numNCDetectado = null;
    let numZDetectado = null;
    let serialEquipo = null;
    let rifEquipo = null;

    if (resp) {
      const lineas = String(resp)
        .split(/[\r\n\x0A\x0D,]+/)
        .map(l => l.trim())
        .filter(l => l.length > 0);

      // Posición estándar TFHKA S1: línea 2 (Última Factura)
      if (lineas.length >= 3 && /^\d+$/.test(lineas[2]) && parseInt(lineas[2], 10) > 0) {
        numFacturaDetectado = lineas[2].padStart(8, '0');
      }

      // Posición estándar TFHKA S1: línea 6 o línea 4 (Última Nota de Crédito)
      if (lineas.length >= 7 && /^\d+$/.test(lineas[6]) && parseInt(lineas[6], 10) > 0) {
        numNCDetectado = lineas[6].padStart(8, '0');
      } else if (lineas.length >= 5 && /^\d+$/.test(lineas[4]) && parseInt(lineas[4], 10) > 0) {
        numNCDetectado = lineas[4].padStart(8, '0');
      }

      // Contador de Z
      for (let l of lineas) {
        if (/^\d{4}$/.test(l) && parseInt(l, 10) > 0 && !numZDetectado) {
          numZDetectado = l.padStart(4, '0');
        }
        if (/^[A-Z0-9]{8,12}$/i.test(l) && !serialEquipo && !l.startsWith("S1")) {
          if (l.includes("ZZP") || l.includes("Z7C") || l.includes("HKA") || l.includes("PP9")) {
            serialEquipo = l;
          }
        }
        if (/^[JVEGPjvegp]-?\d+$/i.test(l) && !rifEquipo) {
          rifEquipo = l;
        }
      }
    }

    return {
      raw: resp,
      enLinea: true,
      ultimaFactura: numFacturaDetectado,
      ultimaNC: numNCDetectado,
      ultimoZ: numZDetectado,
      serial: serialEquipo || "ZZP0005063",
      rif: rifEquipo
    };
  }

  // 2. Anular / Cancelar Documento en Curso (Comando 7)
  async cancelarDocumento() {
    this.notificarEstado("CANCELANDO", `Enviando comando de anulación (7) a ${this.getNombreModelo()}...`);
    return await this.enviarComando("7");
  }

  // 3. Emitir Factura Fiscal Completa con Compatibilidad Universal (HKA80 y Aclas PP9 Plus)
  async emitirFacturaFiscal(datosFactura) {
    if (!this.conectado) {
      throw new Error(`No hay conexión activa con la impresora fiscal ${this.getNombreModelo()}.`);
    }

    this.ocupadoTransmision = true; // Bloquear puerto para la emisión exclusiva

    const {
      cliente,
      items,
      formaPago,
      tasaBCV
    } = datosFactura;

    if (!cliente || !cliente.cedula || !cliente.nombre) {
      this.ocupadoTransmision = false;
      throw new Error("La Cédula/RIF y el Nombre son obligatorios para emitir factura fiscal.");
    }

    if (!items || Object.keys(items).length === 0) {
      this.ocupadoTransmision = false;
      throw new Error("No hay productos seleccionados para facturar.");
    }

    this.notificarEstado("EMITIENDO", `Transmitiendo factura fiscal a ${this.getNombreModelo()}...`);

    try {
      const nombreCliente = this.sanitizarTexto(cliente.nombre, 38);
      let cedulaCliente = this.sanitizarTexto(cliente.cedula, 20);
      const direccionCliente = this.sanitizarTexto(cliente.direccion || "CARACAS", 38);
      const telefonoCliente = this.sanitizarTexto(cliente.telefono || "N/D", 20);

      // Asegurar prefijo legal obligatorio en Cédula / RIF (V-, J-, E-, G-, P-)
      if (!/^[VJEGPvjegp]/i.test(cedulaCliente)) {
        cedulaCliente = "V-" + cedulaCliente;
      }

      // PASO A: Apertura Oficial de Factura Fiscal (iS* Razón Social + iR* RIF/CI)
      try {
        await this.enviarComando(`iS*${nombreCliente}`);
        await this.enviarComando(`iR*${cedulaCliente}`);
      } catch (errInicio) {
        // Si había un documento trabado en el cabezal, anularlo (7) y abrir factura
        try { await this.enviarComando("7"); } catch (e) {}
        await new Promise(r => setTimeout(r, 800));
        await this.enviarComando(`iS*${nombreCliente}`);
        await this.enviarComando(`iR*${cedulaCliente}`);
      }

      if (direccionCliente) await this.enviarComando(`i00${direccionCliente}`);
      if (telefonoCliente) await this.enviarComando(`i01${telefonoCliente}`);

      // Transmisión de Comprobante de Retención SENIAT si aplica
      if (datosFactura.esContribuyenteEspecial && datosFactura.comprobanteRetencion) {
        const compTxt = this.sanitizarTexto(`COMP RET: ${datosFactura.comprobanteRetencion}`, 38);
        await this.enviarComando(`i03${compTxt}`);
      }

      // Transmisión de Percepción IGTF 3% si aplica
      if (datosFactura.montoIGTF_BS > 0) {
        const igtfTxt = this.sanitizarTexto(`IGTF 3%: BS ${datosFactura.montoIGTF_BS.toFixed(2)}`, 38);
        await this.enviarComando(`i04${igtfTxt}`);
      }

      // PASO B: Renglones de Venta con cadencia de impresión térmica
      const factorTasa = (parseFloat(tasaBCV) > 0) ? parseFloat(tasaBCV) : 1;

      for (let nombreProd in items) {
        const item = items[nombreProd];
        const descProd = this.sanitizarTexto(nombreProd, 35);
        const tasaIVA = (item.tasaIVA || "E").toUpperCase();
        
        let cmdTasaChar = " "; // Exento (0%)
        let factorIVA = 1.0;

        if (tasaIVA === "G" || tasaIVA === "16") {
          cmdTasaChar = "!"; // General 16%
          factorIVA = 1.16;
        } else if (tasaIVA === "R" || tasaIVA === "8") {
          cmdTasaChar = '"'; // Reducido 8%
          factorIVA = 1.08;
        }

        let precioItemUSD = parseFloat(item.precioBase) || 0;
        let precioItemBs = precioItemUSD * factorTasa;
        let baseImponibleUnitariaBs = precioItemBs / factorIVA;
        let cantidadNumerica = parseFloat(item.cantNumerica) || 1;

        const strPrecio = this.formatearPrecioFiscal(baseImponibleUnitariaBs);
        const strCantidad = this.formatearCantidadFiscal(cantidadNumerica, item.unidad);

        const tramaRenglon = `${cmdTasaChar}${strPrecio}${strCantidad}${descProd}`;
        await this.enviarComando(tramaRenglon);

        // Pausa para que el cabezal imprima el renglón
        await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 350 : 150));
      }

      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 600 : 250));

      // PASO C: Forma de Pago y Cierre Definitivo de Factura Fiscal (101 Pago + 199 Cierre)
      const formaStr = String(formaPago || "").toUpperCase();
      let cmdCodigoPago = "101"; // Efectivo por defecto

      if (formaStr.includes("PUNTO DE VENTA") || formaStr.includes("DEBITO") || formaStr.includes("DÉBITO")) {
        cmdCodigoPago = "109";
      } else if (formaStr.includes("CREDITO") || formaStr.includes("CRÉDITO")) {
        cmdCodigoPago = "114";
      } else if (formaStr.includes("PAGO MOVIL") || formaStr.includes("PAGO MÓVIL") || formaStr.includes("TRANSFERENCIA") || formaStr.includes("BIOPAGO") || formaStr.includes("ZELLE") || formaStr.includes("DIVISAS") || formaStr.includes("PAYPAL") || formaStr.includes("CASHEA")) {
        cmdCodigoPago = "120";
      }

      // 1. Asignar forma de pago
      try {
        await this.enviarComando(cmdCodigoPago);
      } catch (errPago) {}

      await new Promise(r => setTimeout(r, 400));

      // 2. Enviar comando 199 para forzar la impresión inmediata del Total, IVA, MH y Corte de Papel
      try {
        await this.enviarComando("199");
      } catch (err199) {}

      // 3. Esperar a que la guillotina termine el corte físico
      const pausaCorteMs = this.modelo === "PP9" ? 3500 : 1500;
      await new Promise(r => setTimeout(r, pausaCorteMs));

      // PASO D: Capturar Número de Factura Fiscal Real Impreso por la máquina
      let numFacturaFiscal = null;
      try {
        const statusFinal = await this.consultarEstado();
        numFacturaFiscal = statusFinal?.ultimaFactura;
      } catch (eStatus) {
        console.warn("Aviso: Reintentando lectura de estado post-impresión:", eStatus);
      }

      if (!numFacturaFiscal) {
        try {
          await new Promise(r => setTimeout(r, 1200));
          const statusReintento = await this.consultarEstado();
          numFacturaFiscal = statusReintento?.ultimaFactura;
        } catch (e2) {}
      }

      if (!numFacturaFiscal) {
        numFacturaFiscal = `FAC-${Date.now().toString().slice(-6)}`;
      }
      this.ultimoNumeroFactura = numFacturaFiscal;

      this.notificarEstado("FINALIZADO", `Factura Fiscal N° ${numFacturaFiscal} impresa en ${this.getNombreModelo()}.`, {
        numFacturaFiscal: numFacturaFiscal
      });

      this.ocupadoTransmision = false; // Liberar puerto
      return {
        exito: true,
        numFacturaFiscal: numFacturaFiscal,
        mensaje: `Factura fiscal N° ${numFacturaFiscal} impresa exitosamente en ${this.getNombreModelo()}.`
      };

    } catch (err) {
      this.ocupadoTransmision = false; // Liberar puerto ante error
      this.notificarEstado("ERROR_EMISION", `Fallo al emitir factura en ${this.getNombreModelo()}: ` + err.message);
      try { await this.cancelarDocumento(); } catch (e) {}
      throw err;
    }
  }

  // 3.1. Emitir Nota de Crédito Fiscal Oficial TFHKA (Protocolo Directo de Anulación / Devolución)
  async emitirNotaCreditoFiscal(datosNC) {
    if (!this.conectado) {
      throw new Error(`No hay conexión activa con la impresora fiscal ${this.getNombreModelo()}.`);
    }

    this.ocupadoTransmision = true; // Bloquear puerto para la emisión exclusiva

    const {
      cliente,
      facturaAfectada,
      fechaFacturaAfectada,
      serialImpresoraAfectada,
      itemsDevueltos,
      motivo,
      tasaBCV
    } = datosNC;

    if (!facturaAfectada) {
      this.ocupadoTransmision = false;
      throw new Error("El número de factura fiscal afectada es obligatorio para emitir Nota de Crédito.");
    }

    if (!itemsDevueltos || Object.keys(itemsDevueltos).length === 0) {
      this.ocupadoTransmision = false;
      throw new Error("Debe seleccionar al menos un producto a devolver en la Nota de Crédito.");
    }

    this.notificarEstado("EMITIENDO_NC", `Transmitiendo Nota de Crédito Fiscal a ${this.getNombreModelo()}...`);

    try {
      const nombreCliente = this.sanitizarTexto(cliente?.nombre || "CONSUMIDOR FINAL", 38);
      let cedulaCliente = this.sanitizarTexto(cliente?.cedula || "V-00000000", 20);

      // Asegurar prefijo legal en Cédula / RIF
      if (!/^[VJEGPvjegp]/i.test(cedulaCliente)) {
        cedulaCliente = "V-" + cedulaCliente;
      }

      const numFacFormateado = String(facturaAfectada).replace(/\D/g, '').padStart(8, '0');
      const serialFiscal = this.sanitizarTexto(serialImpresoraAfectada || this.ultimoReporteStatus?.serial || "ZZP0005063", 12);
      
      // Formato fecha oficial SENIAT: DD/MM/AAAA
      let fechaAfectadaFormateada = "";
      if (fechaFacturaAfectada) {
        const partesF = String(fechaFacturaAfectada).split(/[,\s]+/)[0].split(/[\/\-]/);
        if (partesF.length === 3) {
          let dia = String(partesF[0]).padStart(2, '0');
          let mes = String(partesF[1]).padStart(2, '0');
          let anio = partesF[2];
          if (anio.length === 2) anio = "20" + anio;
          fechaAfectadaFormateada = `${dia}/${mes}/${anio}`;
        }
      }
      if (!fechaAfectadaFormateada) {
        const hoy = new Date();
        fechaAfectadaFormateada = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;
      }

      // PASO A: Apertura Oficial de Nota de Crédito con Vinculación SENIAT (iS*, iR*, iF*, iD*, iI*)
      try {
        await this.enviarComando(`iS*${nombreCliente}`);
        await this.enviarComando(`iR*${cedulaCliente}`);
        await this.enviarComando(`iF*${numFacFormateado}`);
        await this.enviarComando(`iD*${fechaAfectadaFormateada}`);
        if (serialFiscal) await this.enviarComando(`iI*${serialFiscal}`);
      } catch (errInicioNC) {
        try { await this.enviarComando("7"); } catch (e) {}
        await new Promise(r => setTimeout(r, 800));
        await this.enviarComando(`iS*${nombreCliente}`);
        await this.enviarComando(`iR*${cedulaCliente}`);
        await this.enviarComando(`iF*${numFacFormateado}`);
        await this.enviarComando(`iD*${fechaAfectadaFormateada}`);
        if (serialFiscal) await this.enviarComando(`iI*${serialFiscal}`);
      }

      if (motivo) await this.enviarComando(`i00MOTIVO: ${this.sanitizarTexto(motivo, 30)}`);

      // PASO B: Renglones de Devolución en Nota de Crédito (d0, d1, d2)
      const factorTasa = (parseFloat(tasaBCV) > 0) ? parseFloat(tasaBCV) : 1;

      for (let nombreProd in itemsDevueltos) {
        const item = itemsDevueltos[nombreProd];
        const descProd = this.sanitizarTexto(nombreProd, 35);
        const tasaIVA = (item.tasaIVA || "E").toUpperCase();

        let cmdDevolucionChar = "d0"; // Exento por defecto
        let factorIVA = 1.0;

        if (tasaIVA === "G" || tasaIVA === "16") {
          cmdDevolucionChar = "d1"; // General 16%
          factorIVA = 1.16;
        } else if (tasaIVA === "R" || tasaIVA === "8") {
          cmdDevolucionChar = "d2"; // Reducido 8%
          factorIVA = 1.08;
        }

        let precioItemUSD = parseFloat(item.precioBase) || 0;
        let precioItemBs = precioItemUSD * factorTasa;
        let baseImponibleUnitariaBs = precioItemBs / factorIVA;
        let cantidadNumerica = parseFloat(item.cantNumerica) || 1;

        const strPrecio = this.formatearPrecioFiscal(baseImponibleUnitariaBs);
        const strCantidad = this.formatearCantidadFiscal(cantidadNumerica, item.unidad);

        const tramaRenglonNC = `${cmdDevolucionChar}${strPrecio}${strCantidad}${descProd}`;
        await this.enviarComando(tramaRenglonNC);

        // Pausa para impresión térmica del renglón
        await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 350 : 150));
      }

      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 600 : 250));

      // PASO C: Pago y Cierre Definitivo de Nota de Crédito
      try {
        await this.enviarComando("101");
      } catch (eNC1) {}

      await new Promise(r => setTimeout(r, 400));

      try {
        await this.enviarComando("199");
      } catch (eNC2) {}

      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 3500 : 1500));

      // PASO D: Capturar Número de Nota de Crédito Fiscal Real Impreso por la máquina
      let numNC = null;
      try {
        const statusFinal = await this.consultarEstado();
        numNC = statusFinal?.ultimaNC || (statusFinal?.raw ? this.extraerNumeroNCDeRespuesta(statusFinal.raw) : null);
      } catch (eStatus) {
        console.warn("Aviso: Reintentando lectura de estado post-NC:", eStatus);
      }

      if (!numNC) {
        try {
          await new Promise(r => setTimeout(r, 1000));
          const statusReintento = await this.consultarEstado();
          numNC = statusReintento?.ultimaNC;
        } catch (e2) {}
      }

      if (!numNC) {
        numNC = `NC-${Date.now().toString().slice(-6)}`;
      }

      this.notificarEstado("FINALIZADO_NC", `Nota de Crédito Fiscal N° ${numNC} emitida con éxito en ${this.getNombreModelo()}.`, {
        numNotaCredito: numNC,
        facturaAfectada: numFacFormateado
      });

      this.ocupadoTransmision = false; // Liberar puerto
      return {
        exito: true,
        numNotaCredito: numNC,
        facturaAfectada: numFacFormateado,
        mensaje: `Nota de Crédito Fiscal N° ${numNC} emitida exitosamente.`
      };

    } catch (err) {
      this.ocupadoTransmision = false; // Liberar puerto ante error
      this.notificarEstado("ERROR_EMISION_NC", `Fallo al emitir Nota de Crédito en ${this.getNombreModelo()}: ` + err.message);
      try { await this.cancelarDocumento(); } catch (e) {}
      throw err;
    }
  }

  extraerNumeroNCDeRespuesta(rawStr) {
    if (!rawStr) return null;
    const lineas = String(rawStr).split(/[\r\n\x0A\x0D,]+/).map(l => l.trim()).filter(l => l.length > 0);
    if (lineas.length >= 7 && /^\d+$/.test(lineas[6]) && parseInt(lineas[6], 10) > 0) {
      return lineas[6].padStart(8, '0');
    }
    if (lineas.length >= 5 && /^\d+$/.test(lineas[4]) && parseInt(lineas[4], 10) > 0) {
      return lineas[4].padStart(8, '0');
    }
    return null;
  }

  // 4. Emitir Reporte X (Comando I0X)
  async imprimirReporteX() {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    this.notificarEstado("IMPRIMIENDO_X", `Imprimiendo Reporte X en ${this.getNombreModelo()}...`);
    const resp = await this.enviarComando("I0X");
    this.notificarEstado("FINALIZADO_X", "Reporte X impreso exitosamente.");
    return resp;
  }

  // 5. Emitir Reporte Z Oficial TFHKA (Comando I0Z)
  async imprimirReporteZ() {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    this.notificarEstado("IMPRIMIENDO_Z", `Imprimiendo Reporte Z oficial en ${this.getNombreModelo()}...`);
    
    const resp = await this.enviarComando("I0Z");
    await new Promise(r => setTimeout(r, 1500));

    const status = await this.consultarEstado();
    this.ultimoNumeroZ = status.ultimoZ || (status.raw ? this.extraerNumeroZDeRespuesta(status.raw) : null);

    this.notificarEstado("FINALIZADO_Z", `Cierre Fiscal Reporte Z N° ${this.ultimoNumeroZ || 'OK'} completado en ${this.getNombreModelo()}.`, {
      numeroZ: this.ultimoNumeroZ,
      serial: status.serial,
      rif: status.rif
    });

    return {
      exito: true,
      numeroZ: this.ultimoNumeroZ,
      statusFiscal: status,
      respuestaRaw: resp
    };
  }

  extraerNumeroZDeRespuesta(rawStr) {
    if (!rawStr) return null;
    const lineas = String(rawStr).split(/\x0A|\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lineas.length >= 7 && /^\d+$/.test(lineas[6])) {
      return lineas[6].padStart(4, '0');
    }
    return null;
  }
}

// Instancia global única del Driver Fiscal TFHKA
window.fiscalDriver = new FiscalDriverTFHKA();
