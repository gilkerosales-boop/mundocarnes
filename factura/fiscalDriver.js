/* ==========================================================================
   Driver Fiscal Universal JS - The Factory HKA (TFHKA Venezuela)
   Soporte Multi-Modelo: Aclas PP9 Plus y The Factory HKA80 (80mm)
   Comunicación Serial Nativa Web Serial API para PWA Frigorífico Mundocarnes
   ========================================================================== */

class FiscalDriverTFHKA {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.conectado = false;
    this.modelo = localStorage.getItem("pos_modelo_impresora_fiscal") || "HKA80"; // "HKA80" o "PP9"
    this.baudRate = this.obtenerBaudRatePorDefecto();
    this.timeoutMs = 9000;
    this.enLectura = false;
    this.ultimoNumeroFactura = null;
    this.ultimoNumeroZ = null;
    this.ultimoReporteStatus = null;
    this.onStatusChangeCallback = null;
  }

  // Comprobar compatibilidad de Web Serial API en el navegador
  static esCompatible() {
    return 'serial' in navigator;
  }

  obtenerBaudRatePorDefecto() {
    // HKA80 suele operar a 9600 o 19200 bps; PP9 Plus a 9600 bps
    return this.modelo === "HKA80" ? 19200 : 9600;
  }

  setModelo(nuevoModelo) {
    this.modelo = nuevoModelo === "PP9" ? "PP9" : "HKA80";
    this.baudRate = this.obtenerBaudRatePorDefecto();
    localStorage.setItem("pos_modelo_impresora_fiscal", this.modelo);
    this.notificarEstado("CAMBIO_MODELO", `Modelo fiscal activo: ${this.getNombreModelo()}`);
  }

  getNombreModelo() {
    return this.modelo === "HKA80" ? "The Factory HKA80" : "Aclas PP9 Plus";
  }

  // Registrar callback para notificaciones de estado
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
      throw new Error("Su navegador no soporta Web Serial API. Utilice Google Chrome o Microsoft Edge en PC.");
    }

    try {
      this.baudRate = baudRate || this.obtenerBaudRatePorDefecto();
      this.port = await navigator.serial.requestPort();
      await this.abrirPuerto();
      this.conectado = true;
      this.notificarEstado("CONECTADO", `Impresora fiscal ${this.getNombreModelo()} conectada exitosamente.`);
      return true;
    } catch (err) {
      this.conectado = false;
      this.notificarEstado("ERROR_CONEXION", `No se pudo conectar con ${this.getNombreModelo()}: ` + err.message);
      throw err;
    }
  }

  // Reconectar automáticamente si ya se otorgó permiso previo
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

  // Apertura física de la conexión Serial 8-N-1
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
    }
  }

  // Cerrar y liberar el puerto COM
  async desconectar() {
    try {
      this.conectado = false;
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
      if (this.writer) {
        this.writer.releaseLock();
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
      this.notificarEstado("DESCONECTADO", `Impresora fiscal ${this.getNombreModelo()} desconectada.`);
      return true;
    } catch (err) {
      console.warn("Aviso al cerrar puerto serial:", err);
      return false;
    }
  }

  // Enviar comando fiscal y leer respuesta con control de timeout
  async enviarComando(comandoStr) {
    if (!this.conectado || !this.port || !this.port.writable) {
      throw new Error(`La impresora fiscal ${this.getNombreModelo()} no está conectada. Verifique el cable USB.`);
    }

    try {
      // 1. Escribir comando en el puerto
      const encoder = new TextEncoder();
      const data = encoder.encode(comandoStr + "\n");
      
      this.writer = this.port.writable.getWriter();
      await this.writer.write(data);
      this.writer.releaseLock();
      this.writer = null;

      // 2. Leer respuesta de la impresora fiscal
      const respuesta = await this.leerRespuesta();
      return respuesta;
    } catch (err) {
      if (this.writer) {
        try { this.writer.releaseLock(); } catch (e) {}
        this.writer = null;
      }
      throw new Error(`Fallo de comunicación (${this.getNombreModelo()}): ${err.message}`);
    }
  }

  // Lector con timeout para capturar bytes de retorno de la placa fiscal
  async leerRespuesta() {
    if (!this.port || !this.port.readable) return "";

    const decoder = new TextDecoder();
    let respuestaAcumulada = "";
    this.reader = this.port.readable.getReader();

    const tiempoInicio = Date.now();

    try {
      while (Date.now() - tiempoInicio < this.timeoutMs) {
        const { value, done } = await Promise.race([
          this.reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_LECTURA")), 1500))
        ]).catch(err => {
          if (err.message === "TIMEOUT_LECTURA") return { value: null, done: true };
          throw err;
        });

        if (done || !value) break;

        respuestaAcumulada += decoder.decode(value, { stream: true });

        if (respuestaAcumulada.includes("\n") || respuestaAcumulada.includes("\r") || respuestaAcumulada.includes("\x03")) {
          break;
        }
      }
    } catch (e) {
      // Continuar con lo acumulado
    } finally {
      if (this.reader) {
        try { this.reader.releaseLock(); } catch (e) {}
        this.reader = null;
      }
    }

    return respuestaAcumulada.trim();
  }

  // ========================================================================
  // FORMATEADORES DE DATOS ESTRICTOS (PROTOCOLO THE FACTORY HKA)
  // ========================================================================

  sanitizarTexto(texto, maxLen = 40) {
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
  // OPERACIONES FISCALES DE ALTO NIVEL (HKA80 / ACLAS PP9 PLUS)
  // ========================================================================

  // 1. Consultar Estado de la Máquina Fiscal (Comando S1)
  async consultarEstado() {
    this.notificarEstado("CONSULTANDO", `Consultando estado S1 en ${this.getNombreModelo()}...`);
    const resp = await this.enviarComando("S1");
    this.ultimoReporteStatus = resp;
    
    const partes = resp.split(/[,;\t]/);
    let resultado = {
      raw: resp,
      enLinea: true,
      tapaAbierta: resp.includes("TAPA") || false,
      sinPapel: resp.includes("PAPEL") || false,
      ultimaFactura: partes.length > 2 ? partes[2].trim() : null
    };

    return resultado;
  }

  // 2. Cancelar Documento Fiscal en Curso (Comando 7)
  async cancelarDocumento() {
    this.notificarEstado("CANCELANDO", `Anulando documento en curso en ${this.getNombreModelo()}...`);
    return await this.enviarComando("7");
  }

  // 3. Emitir Factura Fiscal Completa
  async emitirFacturaFiscal(datosFactura) {
    if (!this.conectado) {
      throw new Error(`No hay conexión con la impresora fiscal ${this.getNombreModelo()}.`);
    }

    const {
      cliente,
      items,
      formaPago,
      tasaBCV,
      monedaVistaModal
    } = datosFactura;

    if (!cliente || !cliente.cedula || !cliente.nombre) {
      throw new Error("Los datos de Cédula/RIF y Nombre del cliente son obligatorios para facturación fiscal.");
    }

    if (!items || Object.keys(items).length === 0) {
      throw new Error("No hay productos para emitir en la factura fiscal.");
    }

    this.notificarEstado("EMITIENDO", `Iniciando transmisión de factura fiscal a ${this.getNombreModelo()}...`);

    try {
      // PASO A: Encabezado de Datos del Cliente
      const nombreCliente = this.sanitizarTexto(cliente.nombre, 40);
      const cedulaCliente = this.sanitizarTexto(cliente.cedula, 20);
      const direccionCliente = this.sanitizarTexto(cliente.direccion || "CARACAS", 40);
      const telefonoCliente = this.sanitizarTexto(cliente.telefono || "N/D", 20);

      await this.enviarComando(`i01${nombreCliente}`);
      await this.enviarComando(`i02${cedulaCliente}`);
      if (direccionCliente) await this.enviarComando(`i03${direccionCliente}`);
      if (telefonoCliente) await this.enviarComando(`i04${telefonoCliente}`);

      // PASO B: Transmisión de Renglones con su Tratamiento de IVA
      for (let nombreProd in items) {
        const item = items[nombreProd];
        const descProd = this.sanitizarTexto(nombreProd, 37);

        const tasaIVA = (item.tasaIVA || "E").toUpperCase();
        let cmdTasa = "d0"; // Exento por defecto
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

      // PASO C: Transmisión de Formas de Pago y Cierre de Documento
      let cmdMedioPago = "101"; // Efectivo por defecto
      const formaStr = String(formaPago || "").toUpperCase();

      if (formaStr.includes("PUNTO DE VENTA") || formaStr.includes("DEBITO")) {
        cmdMedioPago = "109";
      } else if (formaStr.includes("CREDITO") || formaStr.includes("CRÉDITO")) {
        cmdMedioPago = "114";
      } else if (formaStr.includes("PAGO MOVIL") || formaStr.includes("TRANSFERENCIA") || formaStr.includes("BIOPAGO")) {
        cmdMedioPago = "120";
      }

      await this.enviarComando(`${cmdMedioPago}`);

      // Comando de cierre final y corte de papel
      const respCierre = await this.enviarComando("199");

      // PASO D: Capturar Número de Factura Fiscal Emitida
      const statusFinal = await this.consultarEstado();
      const numFacturaFiscal = statusFinal.ultimaFactura || `F-${Date.now().toString().slice(-6)}`;
      this.ultimoNumeroFactura = numFacturaFiscal;

      this.notificarEstado("FINALIZADO", `Factura Fiscal N° ${numFacturaFiscal} emitida en ${this.getNombreModelo()}.`, {
        numFacturaFiscal: numFacturaFiscal,
        respuestaRaw: respCierre
      });

      return {
        exito: true,
        numFacturaFiscal: numFacturaFiscal,
        mensaje: `Factura fiscal impresa con éxito en ${this.getNombreModelo()}.`
      };

    } catch (err) {
      this.notificarEstado("ERROR_EMISION", `Error en ${this.getNombreModelo()}: ` + err.message);
      try { await this.cancelarDocumento(); } catch (e) {}
      throw err;
    }
  }

  // 4. Emitir Reporte X (Lectura Parcial - Comando I0X)
  async imprimirReporteX() {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    this.notificarEstado("IMPRIMIENDO_X", `Emitiendo Reporte X en ${this.getNombreModelo()}...`);
    const resp = await this.enviarComando("I0X");
    this.notificarEstado("FINALIZADO_X", "Reporte X emitido exitosamente.");
    return resp;
  }

  // 5. Emitir Reporte Z (Cierre Fiscal Diario - Comando I0Z)
  async imprimirReporteZ() {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    this.notificarEstado("IMPRIMIENDO_Z", `Emitiendo Reporte Z en ${this.getNombreModelo()}...`);
    const resp = await this.enviarComando("I0Z");
    
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

  // 6. Emitir Documento No Fiscal (Comandos 80, 81, 89)
  async imprimirTextoNoFiscal(lineasArray) {
    if (!this.conectado) throw new Error(`Impresora fiscal ${this.getNombreModelo()} no conectada.`);
    
    await this.enviarComando("80");
    for (let linea of lineasArray) {
      const texto = this.sanitizarTexto(linea, 40);
      await this.enviarComando(`81${texto}`);
    }
    await this.enviarComando("89");
  }
}

// Instancia global única del Driver Fiscal TFHKA
window.fiscalDriver = new FiscalDriverTFHKA();
