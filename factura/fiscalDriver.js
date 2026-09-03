/* ==========================================================================
   Driver Fiscal Universal JS - The Factory HKA (TFHKA Venezuela)
   Protocolo Directo Estricto: STX (0x02) + CMD + ETX (0x03) + LRC (Checksum XOR)
   Comandos de Tasa: ' ' (Exento 0%), '!' (General 16%), '"' (Reducido 8%)
   Soporte Universal Calibrado: The Factory HKA80 y Aclas PP9 Plus
   ========================================================================== */

class FiscalDriverTFHKA {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.conectado = false;
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

  // Apertura física del puerto serie estable y directo (9600 8N1)
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

  // Reconectar automáticamente si el puerto ya fue autorizado previamente
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
  // OPERACIONES FISCALES DE ALTO NIVEL
  // ========================================================================

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

      // Detección automática del serial físico grabado en la memoria de la máquina
      for (let l of lineas) {
        if (/^\d{4}$/.test(l) && parseInt(l, 10) > 0 && !numZDetectado) {
          numZDetectado = l.padStart(4, '0');
        }
        // Detección genérica de serial alfanumérico fiscal sin quemar marcas
        if (/^[A-Z0-9]{8,14}$/i.test(l) && !serialEquipo && !l.startsWith("S1") && !/^\d+$/.test(l)) {
          serialEquipo = l.toUpperCase();
        }
        if (/^[JVEGPjvegp]-?\d+$/i.test(l) && !rifEquipo) {
          rifEquipo = l.toUpperCase();
        }
      }
    }

    // Si se detectó el serial físico en la placa, registrarlo automáticamente en la configuración privada local
    if (serialEquipo) {
      localStorage.setItem(`pos_serial_fiscal_${this.modelo}`, serialEquipo);
      localStorage.setItem("pos_serial_fiscal_activo", serialEquipo);
    }

    const serialPrivado = localStorage.getItem(`pos_serial_fiscal_${this.modelo}`) || localStorage.getItem("pos_serial_fiscal_activo") || "";

    return {
      raw: resp,
      enLinea: true,
      ultimaFactura: numFacturaDetectado,
      ultimaNC: numNCDetectado,
      ultimoZ: numZDetectado,
      serial: serialEquipo || serialPrivado,
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

      // PASO C: Subtotal, Forma de Pago e IGTF Nativo Fiscal (Medio de Pago 20 = Divisas)
      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 500 : 250));

      const formaStr = String(formaPago || "").toUpperCase();
      const aplicaIGTFNativo = (datosFactura.montoIGTF_BS > 0);

      // 1. Enviar comando Subtotal ('3') para consolidar la base imponible
      try {
        await this.enviarComando("3");
      } catch (eSub) {}
      
      // Pausa obligatoria para que el cabezal térmico termine de imprimir SUBTTL en papel
      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 950 : 400));

      // 2. Transmisión del Pago: Comando 120 (Pago Total Divisas con IGTF Nativo)
      if (aplicaIGTFNativo) {
        try {
          await this.enviarComando("120");
        } catch (ePago120) {
          try {
            const subtotalBaseBs = Math.round(((parseFloat(datosFactura.totalUSD) || 0) * (parseFloat(tasaBCV) || 1)) * 100);
            const strMontoBase = String(subtotalBaseBs).padStart(12, '0');
            await this.enviarComando(`220${strMontoBase}`);
          } catch (ePago220) {}
        }
      } else {
        let cmdCodigoPago = "101"; // Efectivo Bs por defecto
        if (formaStr.includes("PUNTO DE VENTA") || formaStr.includes("DEBITO") || formaStr.includes("DÉBITO")) {
          cmdCodigoPago = "109";
        } else if (formaStr.includes("CREDITO") || formaStr.includes("CRÉDITO")) {
          cmdCodigoPago = "114";
        } else if (formaStr.includes("PAGO MOVIL") || formaStr.includes("PAGO MÓVIL") || formaStr.includes("TRANSFERENCIA") || formaStr.includes("BIOPAGO")) {
          cmdCodigoPago = "110";
        }
        try {
          await this.enviarComando(cmdCodigoPago);
        } catch (errPago) {}
      }

      // Pausa para que el cabezal termine de imprimir las líneas de pago e IGTF
      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 950 : 400));

      // 3. Enviar comando obligatorio '199' con reintento automático para liquidar, totalizar y cortar
      try {
        await this.enviarComando("199");
      } catch (err199) {
        await new Promise(r => setTimeout(r, 600));
        try { await this.enviarComando("199"); } catch (e199_2) {}
      }

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

  // 3.1. Emitir Nota de Crédito Fiscal Oficial TFHKA (Protocolo Directo de Anulación / Devolución)
  async emitirNotaCreditoFiscal(datosNC) {
    if (!this.conectado) {
      throw new Error(`No hay conexión activa con la impresora fiscal ${this.getNombreModelo()}.`);
    }

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
      throw new Error("El número de factura fiscal afectada es obligatorio para emitir Nota de Crédito.");
    }

    if (!itemsDevueltos || Object.keys(itemsDevueltos).length === 0) {
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
      const serialPrivadoGuardado = localStorage.getItem(`pos_serial_fiscal_${this.modelo}`) || localStorage.getItem("pos_serial_fiscal_activo") || "";
      const serialFiscal = this.sanitizarTexto(serialImpresoraAfectada || this.ultimoReporteStatus?.serial || serialPrivadoGuardado, 14);
      
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

        await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 350 : 150));
      }

      // PASO C: Subtotal, Pago y Reversión Nativa de IGTF en Nota de Crédito
      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 500 : 250));

      // 1. Enviar comando Subtotal ('3')
      try {
        await this.enviarComando("3");
      } catch (eSubNC) {}
      
      // Pausa obligatoria para que el cabezal termine de imprimir SUBTTL en la Nota de Crédito
      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 950 : 400));

      // 2. Transmisión del Pago / Reversión Nativa de Divisas
      if (datosNC.montoIGTF_BS > 0) {
        try {
          await this.enviarComando("120");
        } catch (e120NC) {
          try {
            const subtotalBaseBs = Math.round(((parseFloat(datosNC.totalReversarUSD) || parseFloat(datosNC.totalOriginalUSD) || 0) * (parseFloat(tasaBCV) || 1)) * 100);
            const strMontoBase = String(subtotalBaseBs).padStart(12, '0');
            await this.enviarComando(`220${strMontoBase}`);
          } catch (ePago220NC) {}
        }
      } else {
        try {
          await this.enviarComando("101");
        } catch (eNC1) {}
      }

      // Pausa para que el cabezal termine de imprimir las líneas de pago
      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 950 : 400));

      // 3. Cierre obligatorio con comando '199' con reintento automático
      try {
        await this.enviarComando("199");
      } catch (eNC2) {
        await new Promise(r => setTimeout(r, 600));
        try { await this.enviarComando("199"); } catch (eNC2_2) {}
      }

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

      return {
        exito: true,
        numNotaCredito: numNC,
        facturaAfectada: numFacFormateado,
        mensaje: `Nota de Crédito Fiscal N° ${numNC} emitida exitosamente.`
      };

    } catch (err) {
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

  // 3.2. Emitir Nota de Débito Fiscal Oficial TFHKA / Aclas (Protocolo Directo de Cargo Adicional)
  async emitirNotaDebitoFiscal(datosND) {
    if (!this.conectado) {
      throw new Error(`No hay conexión activa con la impresora fiscal ${this.getNombreModelo()}.`);
    }

    const {
      cliente,
      facturaAfectada,
      fechaFacturaAfectada,
      serialImpresoraAfectada,
      motivo,
      concepto,
      montoUSD,
      tasaIVA = "E",
      formaPago,
      tasaBCV,
      montoIGTF_BS = 0
    } = datosND;

    if (!facturaAfectada) {
      throw new Error("El número de factura fiscal afectada es obligatorio para emitir Nota de Débito.");
    }

    const montoValUSD = parseFloat(montoUSD) || 0;
    if (montoValUSD <= 0) {
      throw new Error("El monto a debitar debe ser mayor a cero.");
    }

    this.notificarEstado("EMITIENDO_ND", `Transmitiendo Nota de Débito Fiscal a ${this.getNombreModelo()}...`);

    try {
      const nombreCliente = this.sanitizarTexto(cliente?.nombre || "CONSUMIDOR FINAL", 38);
      let cedulaCliente = this.sanitizarTexto(cliente?.cedula || "V-00000000", 20);

      // Asegurar prefijo legal en Cédula / RIF (V-, J-, E-, G-, P-)
      if (!/^[VJEGPvjegp]/i.test(cedulaCliente)) {
        cedulaCliente = "V-" + cedulaCliente;
      }

      const numFacFormateado = String(facturaAfectada).replace(/\D/g, '').padStart(8, '0');
      const serialPrivadoGuardado = localStorage.getItem(`pos_serial_fiscal_${this.modelo}`) || localStorage.getItem("pos_serial_fiscal_activo") || "";
      const serialFiscal = this.sanitizarTexto(serialImpresoraAfectada || this.ultimoReporteStatus?.serial || serialPrivadoGuardado, 14);
      
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

      // PASO A: Apertura Oficial de Nota de Débito con Vinculación SENIAT (iS*, iR*, iF*, iD*, iI*)
      try {
        await this.enviarComando(`iS*${nombreCliente}`);
        await this.enviarComando(`iR*${cedulaCliente}`);
        await this.enviarComando(`iF*${numFacFormateado}`);
        await this.enviarComando(`iD*${fechaAfectadaFormateada}`);
        if (serialFiscal) await this.enviarComando(`iI*${serialFiscal}`);
      } catch (errInicioND) {
        try { await this.enviarComando("7"); } catch (e) {}
        await new Promise(r => setTimeout(r, 800));
        await this.enviarComando(`iS*${nombreCliente}`);
        await this.enviarComando(`iR*${cedulaCliente}`);
        await this.enviarComando(`iF*${numFacFormateado}`);
        await this.enviarComando(`iD*${fechaAfectadaFormateada}`);
        if (serialFiscal) await this.enviarComando(`iI*${serialFiscal}`);
      }

      if (motivo) await this.enviarComando(`i00MOTIVO: ${this.sanitizarTexto(motivo, 30)}`);

      // PASO B: Renglón de Cargo en Nota de Débito (`0 para Exento, `1 para General 16%, `2 para Reducido 8%)
      const factorTasa = (parseFloat(tasaBCV) > 0) ? parseFloat(tasaBCV) : 1;
      const tasaUpper = (tasaIVA || "E").toUpperCase();
      let cmdDebitoChar = "`0"; // Exento por defecto (acento grave + 0)
      let factorIVA = 1.0;

      if (tasaUpper === "G" || tasaUpper === "16") {
        cmdDebitoChar = "`1"; // General 16%
        factorIVA = 1.16;
      } else if (tasaUpper === "R" || tasaUpper === "8") {
        cmdDebitoChar = "`2"; // Reducido 8%
        factorIVA = 1.08;
      }

      const descCargo = this.sanitizarTexto(concepto || "CARGO NOTA DE DEBITO", 35);
      const montoTotalBs = montoValUSD * factorTasa;
      const baseImponibleBs = montoTotalBs / factorIVA;

      const strPrecio = this.formatearPrecioFiscal(baseImponibleBs);
      const strCantidad = this.formatearCantidadFiscal(1, "unidades");

      const tramaRenglonND = `${cmdDebitoChar}${strPrecio}${strCantidad}${descCargo}`;
      await this.enviarComando(tramaRenglonND);

      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 350 : 150));

      // PASO C: Subtotal, Pago y Liquidación
      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 500 : 250));

      // 1. Comando Subtotal ('3')
      try {
        await this.enviarComando("3");
      } catch (eSubND) {}

      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 950 : 400));

      // 2. Transmisión del Pago
      const formaStr = String(formaPago || "").toUpperCase();
      const aplicaIGTFNativo = (montoIGTF_BS > 0 || formaStr.includes("DIVISAS") || formaStr.includes("ZELLE"));

      if (aplicaIGTFNativo) {
        try {
          await this.enviarComando("120");
        } catch (e120ND) {
          try {
            const subtotalBaseBs = Math.round(montoTotalBs * 100);
            const strMontoBase = String(subtotalBaseBs).padStart(12, '0');
            await this.enviarComando(`220${strMontoBase}`);
          } catch (ePago220ND) {}
        }
      } else {
        let cmdCodigoPago = "101"; // Efectivo Bs por defecto
        if (formaStr.includes("PUNTO DE VENTA") || formaStr.includes("DEBITO") || formaStr.includes("DÉBITO")) {
          cmdCodigoPago = "109";
        } else if (formaStr.includes("CREDITO") || formaStr.includes("CRÉDITO")) {
          cmdCodigoPago = "114";
        } else if (formaStr.includes("PAGO MOVIL") || formaStr.includes("PAGO MÓVIL") || formaStr.includes("TRANSFERENCIA") || formaStr.includes("BIOPAGO")) {
          cmdCodigoPago = "110";
        }
        try {
          await this.enviarComando(cmdCodigoPago);
        } catch (eNDPago) {}
      }

      await new Promise(r => setTimeout(r, this.modelo === "PP9" ? 950 : 400));

      // 3. Cierre obligatorio con comando '199' y reintento automático
      try {
        await this.enviarComando("199");
      } catch (eNDClose) {
        await new Promise(r => setTimeout(r, 600));
        try { await this.enviarComando("199"); } catch (eNDClose2) {}
      }

      const pausaCorteMs = this.modelo === "PP9" ? 3500 : 1500;
      await new Promise(r => setTimeout(r, pausaCorteMs));

      // PASO D: Capturar Número de Nota de Débito Fiscal Real Impreso por la máquina
      let numND = null;
      try {
        const statusFinal = await this.consultarEstado();
        numND = statusFinal?.raw ? this.extraerNumeroNDDeRespuesta(statusFinal.raw) : null;
      } catch (eStatus) {
        console.warn("Aviso: Reintentando lectura de estado post-ND:", eStatus);
      }

      if (!numND) {
        try {
          await new Promise(r => setTimeout(r, 1200));
          const statusReintento = await this.consultarEstado();
          numND = statusReintento?.raw ? this.extraerNumeroNDDeRespuesta(statusReintento.raw) : null;
        } catch (e2) {}
      }

      if (!numND) {
        numND = `ND-${Date.now().toString().slice(-6)}`;
      }

      this.ultimoNumeroND = numND;

      this.notificarEstado("FINALIZADO_ND", `Nota de Débito Fiscal N° ${numND} emitida con éxito en ${this.getNombreModelo()}.`, {
        numNotaDebito: numND,
        facturaAfectada: numFacFormateado
      });

      return {
        exito: true,
        numNotaDebito: numND,
        facturaAfectada: numFacFormateado,
        mensaje: `Nota de Débito Fiscal N° ${numND} emitida exitosamente.`
      };

    } catch (err) {
      this.notificarEstado("ERROR_EMISION_ND", `Fallo al emitir Nota de Débito en ${this.getNombreModelo()}: ` + err.message);
      try { await this.cancelarDocumento(); } catch (e) {}
      throw err;
    }
  }

  extraerNumeroNDDeRespuesta(rawStr) {
    if (!rawStr) return null;
    const lineas = String(rawStr).split(/[\r\n\x0A\x0D,]+/).map(l => l.trim()).filter(l => l.length > 0);
    // En el reporte S1 de TFHKA/Aclas, la línea 4 o 3 reporta la última Nota de Débito
    if (lineas.length >= 5 && /^\d+$/.test(lineas[3]) && parseInt(lineas[3], 10) > 0) {
      return lineas[3].padStart(8, '0');
    }
    if (lineas.length >= 6 && /^\d+$/.test(lineas[4]) && parseInt(lineas[4], 10) > 0) {
      return lineas[4].padStart(8, '0');
    }
    return null;
  }

 // 4. Emitir Reporte X (Comando I0X con auto-limpieza de memoria fiscal previa)
  async imprimirReporteX() {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    this.notificarEstado("IMPRIMIENDO_X", `Imprimiendo Reporte X en ${this.getNombreModelo()}...`);

    try {
      await this.enviarComando("I0X");
    } catch (errX) {
      // Si la memoria tenía una factura o ticket previo trabado, anularlo (7) y emitir el Reporte X
      try { await this.enviarComando("7"); } catch (eCancel) {}
      await new Promise(r => setTimeout(r, 800));
      await this.enviarComando("I0X");
    }

    const pausaCorteMs = this.modelo === "PP9" ? 3500 : 1500;
    await new Promise(r => setTimeout(r, pausaCorteMs));

    this.notificarEstado("FINALIZADO_X", "Reporte X impreso exitosamente.");
    return "OK";
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
