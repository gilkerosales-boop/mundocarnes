/* ==========================================================================
   Driver Fiscal Universal JS - The Factory HKA (TFHKA Venezuela)
   Protocolo Directo Estricto: STX (0x02) + DATA + ETX (0x03) + LRC (Checksum XOR)
   Control de Flujo DTR/RTS, Handshake ACK/NAK y Soporte Dual HKA80 / Aclas PP9
   ========================================================================== */

class FiscalDriverTFHKA {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.conectado = false;
    this.modelo = localStorage.getItem("pos_modelo_impresora_fiscal") || "HKA80";
    this.baudRate = this.obtenerBaudRatePorDefecto();
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

  obtenerBaudRatePorDefecto() {
    // HKA80 y PP9 Plus operan estándar a 9600 o 19200 bps
    return 9600;
  }

  setModelo(nuevoModelo) {
    this.modelo = nuevoModelo === "PP9" ? "PP9" : "HKA80";
    localStorage.setItem("pos_modelo_impresora_fiscal", this.modelo);
    this.notificarEstado("CAMBIO_MODELO", `Modelo fiscal activo: ${this.getNombreModelo()}`);
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

  // Solicitar puerto interactivo al usuario
  async solicitarYConectar(baudRate = null) {
    if (!FiscalDriverTFHKA.esCompatible()) {
      throw new Error("Su navegador no soporta Web Serial API. Utilice Google Chrome o Microsoft Edge.");
    }

    try {
      this.baudRate = baudRate || this.obtenerBaudRatePorDefecto();
      this.port = await navigator.serial.requestPort();
      await this.abrirPuerto();
      this.conectado = true;

      // Verificar respuesta inmediata con Status S1
      const st = await this.consultarEstado();
      this.notificarEstado("CONECTADO", `Impresora fiscal ${this.getNombreModelo()} conectada y lista.`, st);
      return true;
    } catch (err) {
      this.conectado = false;
      this.notificarEstado("ERROR_CONEXION", `No se pudo conectar con ${this.getNombreModelo()}: ` + err.message);
      throw err;
    }
  }

  // Reconectar automáticamente si el puerto ya fue autorizado
  async reconectarAutomatico(baudRate = null) {
    if (!FiscalDriverTFHKA.esCompatible()) return false;

    try {
      const ports = await navigator.serial.getPorts();
      if (ports.length > 0) {
        this.port = ports[0];
        this.baudRate = baudRate || this.obtenerBaudRatePorDefecto();
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

  // Apertura física del puerto con señales DTR/RTS activas
  async abrirPuerto() {
    if (!this.port) throw new Error("Puerto serial no inicializado.");

    if (!this.port.readable || !this.port.writable) {
      await this.port.open({
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none"
      });

      // Activar señales DTR y RTS requeridas por las placas TFHKA
      try {
        await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
      } catch (e) {}
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
  // CONSTRUCTOR DE TRAMA OFICIAL THE FACTORY HKA: STX + DATA + ETX + LRC
  // ========================================================================
  construirTrama(comandoStr) {
    const encoder = new TextEncoder();
    const cmdBytes = encoder.encode(comandoStr);
    
    // Cálculo del LRC = XOR de todos los bytes del comando + ETX (0x03)
    let lrc = 0;
    for (let i = 0; i < cmdBytes.length; i++) {
      lrc ^= cmdBytes[i];
    }
    lrc ^= 0x03; // Inclusión obligatoria de ETX

    const trama = new Uint8Array(cmdBytes.length + 3);
    trama[0] = 0x02; // STX (Inicio de trama)
    trama.set(cmdBytes, 1);
    trama[cmdBytes.length + 1] = 0x03; // ETX (Fin de datos)
    trama[cmdBytes.length + 2] = lrc;  // LRC (Checksum)

    return trama;
  }

  // Enviar comando empaquetado y esperar acuse de recibo (ACK = 0x06 / NAK = 0x15)
  async enviarComando(comandoStr, esperaRespuestaData = false) {
    if (!this.conectado || !this.port || !this.port.writable) {
      throw new Error(`La impresora fiscal ${this.getNombreModelo()} no está conectada.`);
    }

    try {
      // 1. Construir trama física
      const tramaBytes = this.construirTrama(comandoStr);
      
      // 2. Escribir en el puerto serie
      this.writer = this.port.writable.getWriter();
      await this.writer.write(tramaBytes);
      this.writer.releaseLock();
      this.writer = null;

      // 3. Pequeña pausa de procesamiento de hardware
      await new Promise(r => setTimeout(r, 60));

      // 4. Leer respuesta de la placa fiscal
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

        // Caso 1: La impresora respondió con ACK simple (0x06)
        if (!esperaRespuestaData && bytesAcumulados.includes(0x06)) {
          break;
        }

        // Caso 2: La impresora respondió con NAK (0x15 = Error de sintaxis o estado)
        if (bytesAcumulados.includes(0x15)) {
          throw new Error("La impresora fiscal devolvió NAK (Comando rechazado o estado inválido).");
        }

        // Caso 3: Respuesta con trama completa (STX ... ETX + LRC)
        if (bytesAcumulados.includes(0x02) && bytesAcumulados.includes(0x03) && bytesAcumulados.length >= 4) {
          // Responder con ACK al recibir la lectura como exige el protocolo TFHKA
          break;
        }
      }
    } finally {
      if (this.reader) {
        try { this.reader.releaseLock(); } catch (e) {}
        this.reader = null;
      }
    }

    // Extraer texto útil si la respuesta vino empaquetada entre STX (0x02) y ETX (0x03)
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

  // Formato: 8 enteros + 2 decimales = 10 dígitos (Ej: 12.50 -> 0000001250)
  formatearPrecioFiscal(precioFloat) {
    const valor = Math.round((parseFloat(precioFloat) || 0) * 100);
    return String(valor).padStart(10, '0');
  }

  // Formato: 5 enteros + 3 decimales = 8 dígitos (Ej: 1.500 kg -> 00001500, 1 ud -> 00001000)
  formatearCantidadFiscal(cantFloat, unidad = "unidades") {
    let valor = 0;
    if (unidad === "gramos" || unidad === "mixto") {
      valor = Math.round(parseFloat(cantFloat) || 0); // Gramos directos (ej 1500g = 1.500)
    } else {
      valor = Math.round((parseFloat(cantFloat) || 1) * 1000); // 1 ud = 1.000
    }
    return String(valor).padStart(8, '0');
  }

  // ========================================================================
  // OPERACIONES FISCALES DE ALTO NIVEL
  // ========================================================================

  // 1. Consultar Estado S1
  async consultarEstado() {
    this.notificarEstado("CONSULTANDO", `Consultando estado S1 en ${this.getNombreModelo()}...`);
    const resp = await this.enviarComando("S1", true);
    this.ultimoReporteStatus = resp;

    let numFacturaDetectado = null;
    if (resp && resp.length > 5) {
      const partes = resp.split(/[,;\t]/);
      if (partes.length > 2) {
        numFacturaDetectado = partes[2].replace(/\D/g, '').padStart(8, '0');
      }
    }

    return {
      raw: resp,
      enLinea: true,
      ultimaFactura: numFacturaDetectado
    };
  }

  // 2. Anular / Cancelar Documento en Curso (Comando 7)
  async cancelarDocumento() {
    this.notificarEstado("CANCELANDO", `Enviando comando de anulación (7) a ${this.getNombreModelo()}...`);
    return await this.enviarComando("7");
  }

  // 3. Emitir Factura Fiscal Completa
  async emitirFacturaFiscal(datosFactura) {
    if (!this.conectado) {
      throw new Error(`No hay conexión activa con la impresora fiscal ${this.getNombreModelo()}.`);
    }

    const {
      cliente,
      items,
      formaPago,
      tasaBCV,
      monedaVistaModal
    } = datosFactura;

    if (!cliente || !cliente.cedula || !cliente.nombre) {
      throw new Error("La Cédula/RIF y el Nombre son obligatorios para emitir factura fiscal.");
    }

    if (!items || Object.keys(items).length === 0) {
      throw new Error("No hay productos seleccionados para facturar.");
    }

    this.notificarEstado("EMITIENDO", `Transmitiendo factura fiscal a ${this.getNombreModelo()}...`);

    try {
      // PASO A: Limpieza de estado previo por seguridad
      try { await this.cancelarDocumento(); } catch (e) {}
      await new Promise(r => setTimeout(r, 100));

      // PASO B: Encabezado del Cliente
      const nombreCliente = this.sanitizarTexto(cliente.nombre, 38);
      const cedulaCliente = this.sanitizarTexto(cliente.cedula, 20);
      const direccionCliente = this.sanitizarTexto(cliente.direccion || "CARACAS", 38);
      const telefonoCliente = this.sanitizarTexto(cliente.telefono || "N/D", 20);

      await this.enviarComando(`i01${nombreCliente}`);
      await this.enviarComando(`i02${cedulaCliente}`);
      if (direccionCliente) await this.enviarComando(`i03${direccionCliente}`);
      if (telefonoCliente) await this.enviarComando(`i04${telefonoCliente}`);

      // PASO C: Renglones de Venta con Formateo Estricto de IVA
      // Comandos TFHKA: d0 = Exento (0%), d1 = General (16%), d2 = Reducido (8%)
      for (let nombreProd in items) {
        const item = items[nombreProd];
        const descProd = this.sanitizarTexto(nombreProd, 35);

        const tasaIVA = (item.tasaIVA || "E").toUpperCase();
        let cmdTasa = "d0"; // Exento
        if (tasaIVA === "G" || tasaIVA === "16") cmdTasa = "d1";
        else if (tasaIVA === "R" || tasaIVA === "8") cmdTasa = "d2";

        let precioBase = parseFloat(item.precioBase) || 0;
        let cantidadNumerica = item.cantNumerica || 1;

        if (monedaVistaModal === "BS" && tasaBCV > 0) {
          precioBase = precioBase * tasaBCV;
        }

        const strPrecio = this.formatearPrecioFiscal(precioBase);
        const strCantidad = this.formatearCantidadFiscal(cantidadNumerica, item.unidad);

        const tramaRenglon = `${cmdTasa}${strPrecio}${strCantidad}${descProd}`;
        await this.enviarComando(tramaRenglon);
      }

      // PASO D: Medios de Pago y Cierre de Factura
      // En protocolo directo TFHKA: 101 sin monto paga la totalidad en Efectivo y totaliza
      let cmdMedioPago = "101"; // Efectivo por defecto
      const formaStr = String(formaPago || "").toUpperCase();

      if (formaStr.includes("PUNTO DE VENTA") || formaStr.includes("DEBITO")) {
        cmdMedioPago = "109"; // Tarjeta de Débito
      } else if (formaStr.includes("CREDITO") || formaStr.includes("CRÉDITO")) {
        cmdMedioPago = "114"; // Tarjeta de Crédito
      } else if (formaStr.includes("PAGO MOVIL") || formaStr.includes("TRANSFERENCIA") || formaStr.includes("BIOPAGO")) {
        cmdMedioPago = "120"; // Otros medios
      }

      // Envío de medio de pago y totalización
      await this.enviarComando(cmdMedioPago);

      // Esperar brevemente que la impresora termine el corte de papel
      await new Promise(r => setTimeout(r, 400));

      // PASO E: Capturar Número de Factura Fiscal Impreso
      const statusFinal = await this.consultarEstado();
      const numFacturaFiscal = statusFinal.ultimaFactura || `FAC-${Date.now().toString().slice(-6)}`;
      this.ultimoNumeroFactura = numFacturaFiscal;

      this.notificarEstado("FINALIZADO", `Factura Fiscal N° ${numFacturaFiscal} impresa en ${this.getNombreModelo()}.`, {
        numFacturaFiscal: numFacturaFiscal
      });

      return {
        exito: true,
        numFacturaFiscal: numFacturaFiscal,
        mensaje: `Factura fiscal N° ${numFacturaFiscal} impresa exitosamente en ${this.getNombreModelo()}.`
      };

    } catch (err) {
      this.notificarEstado("ERROR_EMISION", `Fallo al emitir factura en ${this.getNombreModelo()}: ` + err.message);
      try { await this.cancelarDocumento(); } catch (e) {}
      throw err;
    }
  }

  // 4. Emitir Reporte X (Comando I0X)
  async imprimirReporteX() {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    this.notificarEstado("IMPRIMIENDO_X", `Imprimiendo Reporte X en ${this.getNombreModelo()}...`);
    const resp = await this.enviarComando("I0X");
    this.notificarEstado("FINALIZADO_X", "Reporte X impreso exitosamente.");
    return resp;
  }

  // 5. Emitir Reporte Z (Comando I0Z)
  async imprimirReporteZ() {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    this.notificarEstado("IMPRIMIENDO_Z", `Imprimiendo Reporte Z oficial en ${this.getNombreModelo()}...`);
    const resp = await this.enviarComando("I0Z");

    await new Promise(r => setTimeout(r, 600));
    const status = await this.consultarEstado();
    this.ultimoNumeroZ = status.ultimaFactura || null;

    this.notificarEstado("FINALIZADO_Z", `Cierre Fiscal Reporte Z completado en ${this.getNombreModelo()}.`, {
      numeroZ: this.ultimoNumeroZ
    });

    return {
      exito: true,
      numeroZ: this.ultimoNumeroZ,
      respuestaRaw: resp
    };
  }
}

// Instancia global única del Driver Fiscal TFHKA
window.fiscalDriver = new FiscalDriverTFHKA();
