(window as any)._PhantasmaLinkDetected = true;

interface ICloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface IMessageEvent {
  data: string;
}

interface IErrorEvent {
  message: string;
  type: string;
}

interface IOpenEvent {
  type: string;
}

class PhantasmaLinkSocket {
  // WebSocket compatibility: readyState constants
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  public readyState: number = PhantasmaLinkSocket.CONNECTING;
  
  onopen: (event: IOpenEvent) => void = () => {};
  onerror: (error: IErrorEvent) => void = () => {};
  onclose: (event: ICloseEvent) => void = () => {};
  onmessage: (message: IMessageEvent) => void = () => {};

  private onMessageListener: (msg: any) => void;
  private sid: string;

  onMessageListenerFunc(msg: any) {
    try {
      // Validate message structure
      if (!msg || msg.source !== window) {
        return;
      }
      
      if (!msg.data || typeof msg.data !== 'object') {
        return;
      }

      if (msg.data.uid === "plsres" && msg.data.sid === this.sid) {
        // Only process if socket is open
        if (this.readyState !== PhantasmaLinkSocket.OPEN) {
          return;
        }

        try {
          const msgJson = JSON.stringify(msg.data.data);
          if (this.onmessage) {
            this.onmessage({ data: msgJson });
          }
        } catch (err: any) {
          // Error stringifying message data
          if (this.onerror) {
            this.onerror({
              message: err && err.message ? err.message : 'Failed to process message',
              type: 'error'
            });
          }
        }
      }
    } catch (err: any) {
      // General error handling
      if (this.onerror) {
        this.onerror({
          message: err && err.message ? err.message : 'Message handler error',
          type: 'error'
        });
      }
    }
  }

  constructor() {
    // Generate unique session ID using crypto API if available
    this.sid = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${new Date().getTime()}-${Math.random().toString(36).substring(2, 15)}`;

    this.readyState = PhantasmaLinkSocket.CONNECTING;

    this.onMessageListener = this.onMessageListenerFunc.bind(this);
    window.addEventListener("message", this.onMessageListener);

    setTimeout(() => {
      if (this.readyState === PhantasmaLinkSocket.CONNECTING) {
        this.readyState = PhantasmaLinkSocket.OPEN;
        if (this.onopen) {
          this.onopen({ type: 'open' });
        }
      }
    }, 200);
  }

  public send(msg: string) {
    if (this.readyState !== PhantasmaLinkSocket.OPEN) {
      throw new Error('InvalidStateError: Socket is not open');
    }
    window.postMessage({ uid: "pls", data: msg, sid: this.sid }, "*");
  }

  public close() {
    if (this.readyState === PhantasmaLinkSocket.CLOSED || 
        this.readyState === PhantasmaLinkSocket.CLOSING) {
      return;
    }

    this.readyState = PhantasmaLinkSocket.CLOSING;
    window.removeEventListener("message", this.onMessageListener);
    this.readyState = PhantasmaLinkSocket.CLOSED;

    if (this.onclose) {
      this.onclose({ code: 1000, wasClean: true, reason: "Closed by client" });
    }
  }
}

(window as any).PhantasmaLinkSocket = PhantasmaLinkSocket;
