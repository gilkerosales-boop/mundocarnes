/* ==========================================================================
   Driver Fiscal Universal JS - The Factory HKA (TFHKA Venezuela)
   Protocolo Directo Estricto: STX (0x02) + CMD + ETX (0x03) + LRC (Checksum XOR)
   Comandos de Tasa: ' ' (Exento 0%), '!' (General 16%), '"' (Reducido 8%)
   Soporte Universal: The Factory HKA80 y Aclas PP9 Plus
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

      // Verificar comunicación inmediata con Status S1
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

      // Activar señales DTR y RTS requeridas por las placas fiscales TFHKA
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
    lrc ^= 0x03; // Inclusión obligatoria de ETX

    const trama = new Uint8Array(cmdBytes.length + 3);
    trama[0] = 0x02; // STX (Inicio de trama)
    trama.set(cmdBytes, 1);
    trama[cmdBytes.length + 1] = 0x03; // ETX (Fin de datos)
    trama[cmdBytes.length + 2] = lrc;  // LRC (Checksum)

    return trama;
  }

  // Enviar comando empaquetado y esperar acuse de recibo
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

      // 3. Pausa de procesamiento de hardware entre comandos
      await new Promise(r => setTimeout(r, 80));

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

        // Caso 2: La impresora respondió con NAK (0x15)
        if (bytesAcumulados.includes(0x15)) {
          throw new Error("La impresora fiscal devolvió NAK (Comando rechazado o estado inválido).");
        }

        // Caso 3: Respuesta con trama completa (STX ... ETX + LRC)
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

  // Formato: 8 enteros + 2 decimales = 10 dígitos (Ej: 20.00 -> 0000002000)
  formatearPrecioFiscal(precioFloat) {
    const valor = Math.round((parseFloat(precioFloat) || 0) * 100);
    return String(valor).padStart(10, '0');
  }

  // Formato: 5 enteros + 3 decimales = 8 dígitos (Ej: 1.000 ud -> 00001000, 1.500 kg -> 00001500)
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

  // 1. Consultar Estado S1 con Descodificación Oficial TFHKA (Separador 0x0A) [cite: 1.3.8]
  async consultarEstado() {
    this.notificarEstado("CONSULTANDO", `Consultando estado S1 en ${this.getNombreModelo()}...`);
    const resp = await this.enviarComando("S1", true);
    this.ultimoReporteStatus = resp;

    let numFacturaDetectado = null;
    let numZDetectado = null;
    let serialEquipo = null;
    let rifEquipo = null;

    if (resp) {
      // En protocolo directo TFHKA, los campos vienen separados por 0x0A (\n) [cite: 1.3.8]
      const lineas = String(resp)
        .split(/\x0A|\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0);

      // Posiciones estándar TFHKA:
      // lineas[0]: S101 (Comando + Cajero)
      // lineas[1]: Total ventas acumuladas
      // lineas[2]: NÚMERO DE LA ÚLTIMA FACTURA EMITIDA (ej: 00000005) [cite: 1.3.8]
      // lineas[6]: Contador de Reportes Z [cite: 1.3.8]
      // lineas[8]: RIF [cite: 1.3.8]
      // lineas[9]: Serial de la máquina fiscal [cite: 1.3.8]

      if (lineas.length >= 3 && /^\d+$/.test(lineas[2])) {
        numFacturaDetectado = lineas[2].padStart(8, '0');
      }

      if (lineas.length >= 7 && /^\d+$/.test(lineas[6])) {
        numZDetectado = lineas[6].padStart(4, '0');
      }

      if (lineas.length >= 9) rifEquipo = lineas[8];
      if (lineas.length >= 10) serialEquipo = lineas[9];

      // Caso B: Si la respuesta viene delimitada por comas (puentes/emuladores)
      if (!numFacturaDetectado && resp.includes(',')) {
        const partes = resp.split(',');
        if (partes.length > 2 && /^\d+$/.test(partes[2].trim())) {
          numFacturaDetectado = partes[2].trim().padStart(8, '0');
        }
      }

      // Caso C: Búsqueda segura en las líneas
      if (!numFacturaDetectado) {
        for (let i = 2; i < lineas.length; i++) {
          if (/^\d{6,8}$/.test(lineas[i]) && parseInt(lineas[i], 10) > 0) {
            numFacturaDetectado = lineas[i].padStart(8, '0');
            break;
          }
        }
      }
    }

    return {
      raw: resp,
      enLinea: true,
      ultimaFactura: numFacturaDetectado,
      ultimoZ: numZDetectado,
      serial: serialEquipo,
      rif: rifEquipo
    };
  }

  // 2. Anular / Cancelar Documento en Curso (Comando 7)
  async cancelarDocumento() {
    this.notificarEstado("CANCELANDO", `Enviando comando de anulación (7) a ${this.getNombreModelo()}...`);
    return await this.enviarComando("7");
  }

  // 3. Emitir Factura Fiscal Completa con Comandos de Renglón TFHKA (' ', '!', '"')
// 3. Emitir Factura Fiscal Completa con Comandos de Renglón TFHKA (' ', '!', '"') y Cierre Directo
  async emitirFacturaFiscal(datosFactura) {
    if (!this.conectado) {
      throw new Error(`No hay conexión activa con la impresora fiscal ${this.getNombreModelo()}.`);
    }

    const {
      cliente,
      items,
      formaPago,
      tasaBCV
    } = datosFactura;

    if (!cliente || !cliente.cedula || !cliente.nombre) {
      throw new Error("La Cédula/RIF y el Nombre son obligatorios para emitir factura fiscal.");
    }

    if (!items || Object.keys(items).length === 0) {
      throw new Error("No hay productos seleccionados para facturar.");
    }

    this.notificarEstado("EMITIENDO", `Transmitiendo factura fiscal a ${this.getNombreModelo()}...`);

    try {
      // PASO A: Encabezado de Datos del Cliente (Comandos i01 - i04)
      const nombreCliente = this.sanitizarTexto(cliente.nombre, 38);
      const cedulaCliente = this.sanitizarTexto(cliente.cedula, 20);
      const direccionCliente = this.sanitizarTexto(cliente.direccion || "CARACAS", 38);
      const telefonoCliente = this.sanitizarTexto(cliente.telefono || "N/D", 20);

      await this.enviarComando(`i01${nombreCliente}`);
      await this.enviarComando(`i02${cedulaCliente}`);
      if (direccionCliente) await this.enviarComando(`i03${direccionCliente}`);
      if (telefonoCliente) await this.enviarComando(`i04${telefonoCliente}`);

      // PASO B: Renglones de Venta con Formato Estricto TFHKA y Desglose de Base Imponible
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

        // Conversión a Bolívares y extracción de la Base Imponible unitaria
        let precioItemUSD = parseFloat(item.precioBase) || 0;
        let precioItemBs = precioItemUSD * factorTasa;
        let baseImponibleUnitariaBs = precioItemBs / factorIVA;
        let cantidadNumerica = parseFloat(item.cantNumerica) || 1;

        const strPrecio = this.formatearPrecioFiscal(baseImponibleUnitariaBs);
        const strCantidad = this.formatearCantidadFiscal(cantidadNumerica, item.unidad);

        // Trama oficial: STX + [Tasa] + [Precio 10d] + [Cantidad 8d] + [Descripción] + ETX + LRC
        const tramaRenglon = `${cmdTasaChar}${strPrecio}${strCantidad}${descProd}`;
        await this.enviarComando(tramaRenglon);
      }

      // PASO C: Formas de Pago y Cierre Directo TFHKA (101, 109, 114, 120 sin monto adicional)
      const formaStr = String(formaPago || "").toUpperCase();
      let cmdCodigoPago = "101"; // Efectivo por defecto

      if (formaStr.includes("PUNTO DE VENTA") || formaStr.includes("DEBITO") || formaStr.includes("DÉBITO")) {
        cmdCodigoPago = "109"; // Tarjeta Débito
      } else if (formaStr.includes("CREDITO") || formaStr.includes("CRÉDITO")) {
        cmdCodigoPago = "114"; // Tarjeta Crédito
      } else if (formaStr.includes("PAGO MOVIL") || formaStr.includes("PAGO MÓVIL") || formaStr.includes("TRANSFERENCIA") || formaStr.includes("BIOPAGO") || formaStr.includes("ZELLE") || formaStr.includes("DIVISAS") || formaStr.includes("PAYPAL") || formaStr.includes("CASHEA")) {
        cmdCodigoPago = "120"; // Otros Medios
      }

      // Enviar comando de pago directo total (3 caracteres)
      await this.enviarComando(cmdCodigoPago);

      // Esperar brevemente a que el hardware termine el corte físico de papel
      await new Promise(r => setTimeout(r, 800));

      // PASO D: Capturar Número de Factura Fiscal Impreso
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

  // 5. Emitir Reporte Z Oficial TFHKA (Comando I0Z) y Captura de Contadores [cite: 1.3.8]
  async imprimirReporteZ() {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    this.notificarEstado("IMPRIMIENDO_Z", `Imprimiendo Reporte Z oficial en ${this.getNombreModelo()}...`);
    
    const resp = await this.enviarComando("I0Z");

    // Pausa para finalización del corte físico del Reporte Z
    await new Promise(r => setTimeout(r, 1200));

    // Consultar estado para extraer el Número de Reporte Z generado (ej. 0002) [cite: 1.3.8]
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

  // Extractor auxiliar de correlativo Z
  extraerNumeroZDeRespuesta(rawStr) {
    if (!rawStr) return null;
    const lineas = String(rawStr).split(/\x0A|\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lineas.length >= 7 && /^\d+$/.test(lineas[6])) {
      return lineas[6].padStart(4, '0');
    }
    return null;
  }

// Instancia global única del Driver Fiscal TFHKA
window.fiscalDriver = new FiscalDriverTFHKA();
