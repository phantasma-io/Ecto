import WIF from "wif";
import fetch from "cross-fetch";

import {
  PhantasmaAPI,
  Account,
  Paginated,
  AccountTransactions,
  Balance,
  Swap,
  Token,
} from "phantasma-sdk-ts/core/rpc/index";
import {
  Transaction,
  getPrivateKeyFromWif,
  getAddressFromWif,
  signData,
} from "phantasma-sdk-ts/core/tx/index";
import { bytesToHex } from "phantasma-sdk-ts/core/utils/index";
import {
  TxMsgSigner,
  PhantasmaKeys,
  TxMsg,
} from "phantasma-sdk-ts/core/types/index";
import { formatError, logError } from "@/utils/errors";
import {
  ProtectedWifPayload,
  isProtectedWifPayload,
  protectWifWithPassword,
  revealProtectedWifWithPassword,
} from "@/utils/protectedWif";

const WALLET_STORAGE_VERSION = 1;

// Wallet account mode is a small domain concept, not an ad-hoc string. Keep
// the enum explicit so storage, popup UI, and signing flows all speak the same
// vocabulary.
export enum WalletAccountType {
  WatchOnly = "watchOnly",
  Protected = "protected",
}

export interface ISymbolAmount {
  symbol: string;
  amount: string | number | BigInt;
}

export interface IPendingSwap {
  chainTo: string;
  addressTo: string;
  hash: string;
  swap: Swap | null;
  date: number;
}

interface IAuthorization {
  dapp: string;
  hostname: string;
  token: string;
  address: string;
  expireDate: number;
  version: string;
}

export interface WalletAccount {
  address: string;
  ethAddress?: string;
  neoAddress?: string;
  bscAddress?: string;
  type: WalletAccountType;
  data: Account;
  // Account objects intentionally exclude secret material. Encrypted private
  // keys live in the top-level vault so routine UI/state handling does not drag
  // protected secrets around with every account payload.
}

type WalletVault = Record<string, ProtectedWifPayload>;

function isWalletVault(value: unknown): value is WalletVault {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((entry) =>
    isProtectedWifPayload(entry)
  );
}

export function accountRequiresManualWif(
  account: WalletAccount | null | undefined
): boolean {
  return !account || account.type === WalletAccountType.WatchOnly;
}

export function accountRequiresPassword(
  account: WalletAccount | null | undefined
): boolean {
  return !!account && account.type === WalletAccountType.Protected;
}

export interface TxArgsData {
  nexus: string;
  chain: string;
  script: string;
  payload: string;
}

export interface NexusData<T> {
  mainnet: T | undefined;
  testnet: T | undefined;
  simnet: T | undefined;
  mainnetLastUpdate: number;
  testnetLastUpdate: number;
  simnetLastUpdate: number;
}

function createEmptyAccountData(address: string): Account {
  return {
    address,
    name: "anonymous",
    stakes: {
      amount: "0",
      time: 0,
      unclaimed: "0",
    },
    stake: "0",
    unclaimed: "0",
    relay: "",
    validator: "Invalid",
    storage: {
      available: 0,
      used: 0,
      avatar: "",
      archives: [],
    },
    balances: [],
    txs: [],
  };
}

function normalizeAccountData(address: string, data: unknown): Account {
  const fallback = createEmptyAccountData(address);
  // RPC payloads are not stable enough to trust directly during import/refresh.
  // Normalize them once here so the rest of the popup can assume a complete shape.
  const normalized =
    data && typeof data === "object" ? ({ ...(data as Account) } as Account) : fallback;

  if (!normalized.address || typeof normalized.address !== "string") {
    console.warn("[PopupState] RPC returned account payload without address", {
      requestedAddress: address,
      payload: data,
    });
    normalized.address = address;
  }

  if (normalized.address !== address) {
    console.warn("[PopupState] RPC returned mismatched account address", {
      requestedAddress: address,
      returnedAddress: normalized.address,
    });
  }

  if (!normalized.name) normalized.name = fallback.name;
  if (!normalized.stakes) normalized.stakes = fallback.stakes;
  if (!normalized.stake) normalized.stake = normalized.stakes.amount || fallback.stake;
  if (!normalized.unclaimed)
    normalized.unclaimed = normalized.stakes.unclaimed || fallback.unclaimed;
  if (!normalized.relay) normalized.relay = fallback.relay;
  if (!normalized.validator) normalized.validator = fallback.validator;
  if (!normalized.storage) normalized.storage = fallback.storage;
  if (!Array.isArray(normalized.balances)) normalized.balances = [];
  if (!Array.isArray(normalized.txs)) normalized.txs = [];

  return normalized;
}

export class PopupState {
  api = new PhantasmaAPI("https://pharpc1.phantasma.info/rpc", undefined as any, "none");

  private _currentAccountIndex = 0;
  private _accounts: WalletAccount[] = [];
  private _vault: WalletVault = {};
  private _authorizations: IAuthorization[] = [];
  private _pendingSwaps: IPendingSwap[] = [];
  private _currency: string = "USD";
  private _language: string = "English";
  private _balanceShown: boolean = true;
  private _currenciesRate: any;
  private _nexus: string = "MainNet";
  private _simnetRpc = "http://localhost:7077/rpc";
  private _testnetRpc = "https://testnet.phantasma.info/rpc";
  private _mainnetRpc = "Auto";
  private _defRpcHost = "https://pharpc1.phantasma.info/rpc";
  private _tokens: NexusData<Token[]> = {
    mainnet: [],
    testnet: [],
    simnet: [],
    mainnetLastUpdate: 0,
    testnetLastUpdate: 0,
    simnetLastUpdate: 0,
  };

  accountNfts: any[] = [];
  nfts: any = {};

  isAccountOk = false;

  payload = "4543542d322e302e30"; // "ECT-2.0.0" in hex

  mainetPeers = "https://peers.phantasma.info/mainnet-getpeers.json";
  testnetPeers = "https://peers.phantasma.info/testnet-getpeers.json";

  gasPrice = 100000;
  gasLimit = 500000;

  $i18n: any = {
    t: (s: string) => s,
  };

  availableHosts: any[] = [];

  pingAsync(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      var started = new Date().getTime();
      var http = new XMLHttpRequest();

      http.open('GET', host + '/api/v1/GetNexus', true);
      http.timeout = 4500;
      http.onreadystatechange = function () {
        if (http.readyState == 4 && http.status == 200) {
          var ended = new Date().getTime();
          var milliseconds = ended - started;
          resolve(milliseconds);
        }

        http.ontimeout = function () {
          resolve(100000);
        };
        http.onerror = function () {
          resolve(100000);
        };
      };
      try {
        http.send(null);
      } catch (exception) {
        // this is expected
        reject();
      }
    });
  }

  constructor() {
    const peersUrlJson = this.mainetPeers
    if (peersUrlJson != undefined) {
      fetch(peersUrlJson + '?_=' + new Date().getTime()).then(async (res) => {
        const data = await res.json();
        for (var i = 0; i < data.length; i++) {
          console.log('Checking RPC: ', data[i]);
          try {
            const msecs = await this.pingAsync(data[i].url);
            data[i].info = data[i].location + ' • ' + msecs + ' ms';
            data[i].msecs = msecs;
            console.log(data[i].location + ' • ' + msecs + ' ms • ' + data[i].url + '/rpc');
            this.availableHosts.push(data[i]);
          } catch (err) {
            console.log('Error with RPC: ' + data[i]);
          }
        }
        this.availableHosts.sort((a, b) => a.msecs - b.msecs);
        this.updateRpc();
      });
    }
  }

  get accounts() {
    return this._accounts;
  }

  get currentAccount() {
    return this._currentAccountIndex < this._accounts.length
      ? this._accounts[this._currentAccountIndex]
      : null;
  }

  get hasAccount() {
    return this._accounts.length != 0;
  }

  get currency() {
    return this._currency;
  }

  get balanceShown() {
    return this._balanceShown;
  }

  get language() {
    return this._language;
  }

  get locale() {
    return this.getLocaleFromLanguage(this._language);
  }

  get nexus() {
    return this._nexus.toLowerCase();
  }

  get simnetRpc() {
    return this._simnetRpc;
  }

  get testnetRpc() {
    return this._testnetRpc;
  }

  get mainnetRpc() {
    return this._mainnetRpc;
  }

  getLocaleFromLanguage(language: string) {
    if (language) {
      switch (language) {
        default:
        case "English":
          return "en";
        case "Français":
          return "fr";
        case "Italiano":
          return "it";
        case "Spanish":
          return "es";
        case "Русский":
          return "ru";
        case "中文":
          return "cn";
        case "Nederlands":
          return "nl";
        case "Deutsch":
          return "de";
        case "Türkçe":
          return "tr";
        case "Tiếng Việt":
          return "vn";
        case "Norwegian":
          return "nb";
        case "Português":
          return "pt";
      }
    }
    return "en";
  }

  async setNexus(value: string): Promise<void> {
    console.log("[PS] Setting nexus to", value);
    this._nexus = value;
    this.api.setNexus(value);
    this.updateRpc();

    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          nexus: this._nexus,
          rpc: this.api.host,
        },
        () => resolve()
      );
    });
  }

  async setSimnetRpc(value: string): Promise<void> {
    this._simnetRpc = value;
    this.updateRpc();
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          simnetRpc: this._simnetRpc,
        },
        () => resolve()
      );
    });
  }

  async setTestnetRpc(value: string): Promise<void> {
    this._testnetRpc = value;
    this.updateRpc();
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          testnetRpc: this._testnetRpc,
        },
        () => resolve()
      );
    });
  }

  async setMainnetRpc(value: string): Promise<void> {
    console.log("Saving to storage mainnet rpc", this._mainnetRpc);
    this._mainnetRpc = value;
    this.updateRpc();
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          mainnetRpc: this._mainnetRpc,
        },
        () => resolve()
      );
    });
  }

  get nexusName() {
    return this._nexus;
  }

  get isMainnet() {
    return this.nexus == "mainnet";
  }

  get mainnetRpcList() {
    return this.availableHosts;
  }

  get pendingSwaps() {
    return this._pendingSwaps;
  }

  get claimablePendingSwaps() {
    return this._pendingSwaps.filter((ps) => ps.swap != null);
  }

  private persistWalletState(
    currentAccountIndex: number = this._currentAccountIndex
  ): Promise<void> {
    this._currentAccountIndex = currentAccountIndex;

    return new Promise((resolve) => {
      // Wallet persistence is versioned explicitly at the top level so future
      // storage revisions can be rejected or handled deterministically.
      chrome.storage.local.set(
        {
          storageVersion: WALLET_STORAGE_VERSION,
          currentAccountIndex: this._currentAccountIndex,
          accounts: this._accounts,
          vault: this._vault,
        },
        () => resolve()
      );
    });
  }

  get currencySymbol() {
    switch (this._currency) {
      case "USD":
        return "$";
      case "EUR":
        return "€";
      case "GBP":
        return "£";
      case "JPY":
        return "¥";
      case "CAD":
        return "C$";
      case "AUD":
        return "A$";
      case "CNY":
        return "¥";
      case "RUB":
        return "₽";
      default:
        return "?";
    }
  }

  getRate(symbol: string): number {
    var curSym = this._currency.toLowerCase();
    try {
      switch (symbol.toLowerCase()) {
        case "soul":
          return this._currenciesRate["phantasma"][curSym];
        case "kcal":
          return this._currenciesRate["phantasma-energy"][curSym];
        case "neo":
          return this._currenciesRate["neo"][curSym];
        case "gas":
          return this._currenciesRate["gas"][curSym];
        case "usdt":
          return this._currenciesRate["tether"][curSym];
        case "dai":
          return this._currenciesRate["dai"][curSym];
        case "eth":
          return this._currenciesRate["ethereum"][curSym];
        case "dyt":
          return this._currenciesRate["dynamite"][curSym];
        case "dank":
          return this._currenciesRate["mu-dank"][curSym];
        case "goati":
          return 0.1;
        case "usdc":
          return this._currenciesRate["usd-coin"][curSym];
        case "bnb":
          return this._currenciesRate["binancecoin"][curSym];
        case "busd":
          return this._currenciesRate["binance-usd"][curSym];
        case "ghostmarket":
          return this._currenciesRate["ghostmarket"][curSym];
      }
    } catch {
      console.log("Error getting rates for " + symbol + " in " + curSym);
    }
    return -1;
  }
  
  updateRpc(): void {
    let rpc = this._mainnetRpc == 'Auto' && this.availableHosts.length > 0 ? this.availableHosts[0].url : this._defRpcHost;
    if (this._nexus == "SimNet") rpc = this._simnetRpc;
    if (this._nexus == "TestNet") rpc = this._testnetRpc;

    if (!rpc.endsWith('/rpc')) 
      rpc += '/rpc';

    this.api.setRpcHost(rpc);

    chrome.storage.local.set(
      {
        rpc,
        nexus: this._nexus,
      },
      () => {}
    );
  }

  async check($i18n: any): Promise<void> {
    if ($i18n) this.$i18n = $i18n; // save translate method from Vue i18n
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(async (items) => {
        console.log("[PopupState] Get local storage");
        const hasPersistedWalletState =
          items.accounts !== undefined ||
          items.currentAccountIndex !== undefined ||
          items.vault !== undefined;
        const storageVersion = items.storageVersion;

        if (storageVersion === undefined) {
          if (hasPersistedWalletState) {
            reject(new Error("Unsupported wallet storage format"));
            return;
          }

          // Fresh profiles start with an explicit storage version and an empty
          // vault bucket so all subsequent wallet writes share the same shape.
          this._vault = {};
          chrome.storage.local.set({
            storageVersion: WALLET_STORAGE_VERSION,
            vault: this._vault,
          });
        } else if (storageVersion !== WALLET_STORAGE_VERSION) {
          reject(new Error(`Unsupported wallet storage version: ${storageVersion}`));
          return;
        } else if (items.vault === undefined) {
          // The vault is stored separately from accounts so encrypted secrets
          // are never embedded in the UI-facing account objects.
          this._vault = {};
          chrome.storage.local.set({
            storageVersion: WALLET_STORAGE_VERSION,
            vault: this._vault,
          });
        } else if (!isWalletVault(items.vault)) {
          reject(new Error("Unsupported wallet vault format"));
          return;
        } else {
          this._vault = items.vault;
        }

        this._currentAccountIndex =
          typeof items.currentAccountIndex === "number"
            ? items.currentAccountIndex
            : 0;
        this._accounts = items.accounts ? items.accounts : [];
        this._authorizations = items.authorizations ? items.authorizations : [];
        // this._pendingSwaps = items.pendingSwaps ? items.pendingSwaps : [];
        this._currency = items.currency ? items.currency : "USD";
        this._language = items.language ? items.language : "English";
        this._balanceShown =
          items.balanceShown === undefined || items.balanceShown;
        this.nfts = items.nfts ? items.nfts : {};

        if ($i18n) $i18n.locale = this.locale;

        if (items.tokens) this._tokens = items.tokens;

        console.log("Current tokens", JSON.stringify(this._tokens, null, 2));

        const numAccounts = items.accounts ? items.accounts.length : 0;

        if (items.gasPrice) this.gasPrice = items.gasPrice;
        if (items.gasLimit) this.gasLimit = items.gasLimit;

        if (items.simnetRpc) this._simnetRpc = items.simnetRpc;
        if (items.testnetRpc) this._testnetRpc = items.testnetRpc;
        if (items.mainnetRpc) this._mainnetRpc = items.mainnetRpc;
        if (items.nexus) this._nexus = items.nexus;

        this.api.setNexus(this._nexus);
        this.updateRpc();

        if (this._accounts.length === 0) {
          this._currentAccountIndex = 0;
        } else if (
          this._currentAccountIndex < 0 ||
          this._currentAccountIndex >= this._accounts.length
        ) {
          // Persist the repaired index immediately so reloads do not keep reviving
          // a stale selection after accounts were removed or storage was corrupted.
          console.warn("[PopupState] Repairing invalid currentAccountIndex", {
            currentAccountIndex: this._currentAccountIndex,
            accounts: this._accounts.length,
          });
          this._currentAccountIndex = 0;
          this.persistWalletState(this._currentAccountIndex);
        }

        try {
          // query tokens info if needed for current nexus
          const now = new Date().valueOf();
          const nexus = this.nexus;
          var lastUpdate = (this._tokens as any)[nexus + "LastUpdate"];
          const secsSinceLastUpdate = (now - lastUpdate) / 1000;
          console.log("Last update was ", secsSinceLastUpdate, "secs ago");
          if (secsSinceLastUpdate > 60 * 60 * 2) {
            let tokens = await this.api.getTokens(null);
            // remove script, we don't need it
            tokens.forEach((t: any) => {
              if (t.script != undefined) delete t.script;
            });
            console.log("tokens for", nexus, tokens);
            (this._tokens as any)[nexus] = tokens;
            (this._tokens as any)[nexus + "LastUpdate"] = now;
            chrome.storage.local.set({ tokens: this._tokens });
          }
        } catch (err) {
          console.error("Could not get tokens", err);
        }

        if (this._accounts.length !== numAccounts) {
          this.persistWalletState(this._currentAccountIndex);
        }

        resolve();
      });
    });
  }

  async checkTxError(tx: string): Promise<string | null> {
    const txdata = await this.api.getTransaction(tx);
    const txdataAny = txdata as any;
    console.log("checkTx", txdata);
    if ((txdata as any).error) return 'pending'
    if (!txdata) return null;
    if (txdataAny.Code == -32603 && txdataAny.Message) return txdataAny.Message
    if (txdata.state == 'Fault') {
      if (txdata.events) {
        const errEv = txdata.events.find(e => e.kind == 'ExecutionFailure')        
        if (errEv) {

          let errMsg = `Execution failure in ${errEv.contract} contract`
          const data = errEv.data
          if (data) {
            try {
              var hex = data.substring(2);
              var str = '';
              for (var i = 0; i < hex.length; i += 2)
                  str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
              errMsg = str
            } catch {}
          }
          if (errEv?.contract == 'stake') {
            errMsg += '. (Note: there is a 24h cooldown period after staking or claiming KCAL)'
          }
          return errMsg
        }
      }
      return 'Unknown error'
    }
    if (txdata.state == 'Running') return 'pending'
    return null
  }

  clearAll() {
    chrome.storage.local.clear();

    this._currentAccountIndex = 0;
    this._accounts = [];
    this._vault = {};
    this._authorizations = [];
  }

  async setCurrency(currency: string): Promise<void> {
    this._currency = currency;
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          currency: this._currency,
        },
        () => resolve()
      );
    });
  }

  async setLanguage(language: string): Promise<void> {
    this._language = language;

    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          language: this._language,
        },
        () => resolve()
      );
    });
  }

  async setGasPriceAndLimit(gasPrice: number, gasLimit: number): Promise<void> {
    this.gasPrice = gasPrice;
    this.gasLimit = gasLimit;

    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          gasPrice,
          gasLimit
        },
        () => resolve()
      );
    });   
  }

  async toggleBalance(balanceShown: boolean): Promise<void> {
    this._balanceShown = balanceShown;
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          balanceShown: this._balanceShown,
        },
        () => resolve()
      );
    });
  }

  async fetchRates() {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=phantasma%2Cphantasma-energy%2Cneo%2Cgas%2Ctether%2Cethereum%2Cdai%2Cdynamite%2Cmu-dank%2Cusd-coin%2Cdai%2Ctether%2Cbinancecoin%2Cbinance-usd%2Cghostmarket&vs_currencies=usd%2Ceur%2Cgbp%2Cjpy%2Ccad%2Caud%2Ccny%2Crub"
    );
    const resJson = await res.json();
    this._currenciesRate = resJson;
  }

  async getAccountData(address: string): Promise<Account> {
    let data: Account;

    try {
      data = await this.api.getAccount(address);
    } catch (err) {
      throw new Error(
        `Could not fetch account ${address} from ${this.api.host}: ${formatError(err)}`
      );
    }

    const dataAny = data as any;
    if (!dataAny || dataAny.error) {
      throw new Error(
        `RPC returned invalid account payload for ${address} from ${this.api.host}`
      );
    }

    const normalized = normalizeAccountData(address, data);

    if (!normalized.balances) {
      normalized.balances = [];
    }

    if (!normalized.balances.find((b) => b.symbol == "SOUL"))
      normalized.balances.unshift({
        chain: "main",
        symbol: "SOUL",
        amount: "0",
        decimals: 8,
      });

    // make sure SOUL and KCAL are first
    normalized.balances = normalized.balances.sort((a, b) => {
      if (a.symbol == "SOUL") return -1;
      if (b.symbol == "SOUL") return 1;
      if (a.symbol == "KCAL") return -1;
      if (b.symbol == "KCAL") return 1;
      return a.symbol.localeCompare(b.symbol);
    });

    console.log("Account data", normalized);

    return normalized;
  }

  async addAccount(addressOrName: string): Promise<void> {
    let address = addressOrName;

    if (
      !(address.startsWith("P") || address.startsWith("S")) ||
      address.length != 47
    ) {
      address = await this.api.lookUpName(address);
      if ((address as any).error) throw new Error("Wallet name not found");
    }

    const accountData = await this.getAccountData(address);
    const matchAccount = this.accounts.filter(
      (a) => a.address == accountData.address
    );
    const alreadyExisting = matchAccount.length > 0 ? true : false;
    let len = 0;
    if (!alreadyExisting) {
      len = this._accounts.push({
        address: accountData.address,
        type: WalletAccountType.WatchOnly,
        data: accountData,
      });
    }

    const nextAccountIndex = alreadyExisting ? this._currentAccountIndex : len - 1;
    return this.persistWalletState(nextAccountIndex);
  }

  isWifValidForAccount(
    wif: string,
    account: WalletAccount | undefined = undefined
  ): boolean {
    try {
      return (
        (account && account.address && account.address.startsWith("S")) ||
        (account !== undefined
          ? account.address
          : this.currentAccount?.address) === getAddressFromWif(wif)
      );
    } catch {
      return false;
    }
  }

  async addAccountWithWif(wif: string, password: string): Promise<void> {
    let address = getAddressFromWif(wif);
    let accountData = createEmptyAccountData(address);
    try {
      accountData = await this.getAccountData(address);
    } catch (err) {
      // Import must still succeed when RPC is unavailable; the next refresh can
      // backfill balances and metadata once connectivity recovers.
      logError("Error getting account data during WIF import", err, {
        address,
        rpc: this.api.host,
      });
    }
    const matchAccount = this.accounts.filter(
      (a) => a.address == accountData.address
    );
    const alreadyExisting = matchAccount.length > 0 ? true : false;

    if (!alreadyExisting) {
      this._accounts.push(
        await this.createProtectedWalletAccount(wif, password, accountData)
      );
    }

    const nextAccountIndex = alreadyExisting
      ? this._currentAccountIndex
      : this._accounts.length - 1;
    return this.persistWalletState(nextAccountIndex);
  }

  async addAccountWithHex(hex: string, password: string): Promise<void> {
    let pk = Buffer.from(hex, "hex");
    const wif = WIF.encode(128, pk, true);
    let address = getAddressFromWif(wif);
    let accountData: Account = createEmptyAccountData(address);
    try {
      accountData = await this.getAccountData(address);
    } catch (err) {
      // Mirror WIF import behavior: keep the account locally even when the RPC
      // cannot hydrate balances yet, otherwise valid private keys become unimportable.
      logError("Error getting account data during hex import", err, {
        address,
        rpc: this.api.host,
      });
    }
    const matchAccount = this.accounts.filter(
      (a) => a.address == accountData.address
    );
    const alreadyExisting = matchAccount.length > 0 ? true : false;

    if (!alreadyExisting) {
      this._accounts.push(
        await this.createProtectedWalletAccount(wif, password, accountData)
      );
    }

    const nextAccountIndex = alreadyExisting
      ? this._currentAccountIndex
      : this._accounts.length - 1;
    return this.persistWalletState(nextAccountIndex);
  }

  async selectAccount(account: WalletAccount): Promise<void> {
    const idx = this.accounts.findIndex((a) => a.address == account.address);

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ currentAccountIndex: idx }, () => resolve());
    });
  }

  async deleteAccount(account: WalletAccount): Promise<void> {
    const currentAccount = this.currentAccount;
    this._accounts = this.accounts.filter((a) => a.address != account.address);
    delete this._vault[account.address];
    let idx = this.accounts.findIndex(
      (a) => a.address == currentAccount?.address
    );
    if (idx == -1) idx = 0;

    return this.persistWalletState(idx);
  }

  async refreshCurrentAccount(): Promise<void> {
    const account = this.currentAccount;
    if (!account) return;
    if (!account.address) {
      throw new Error("Current account is missing address");
    }

    console.log(
      "Refreshing account " + account.address + " on " + this.api.host
    );

    this._accounts[this._currentAccountIndex].data = await this.getAccountData(
      account.address
    );

    this.isAccountOk = true;

    const allNfts = this.getAllTokens().filter(
      (t) => t.flags && !t.flags.includes("Fungible")
    );

    // fetch all nfts data available
    for (var i = 0; i < allNfts.length; ++i) {
      try {
        const symbol = allNfts[i].symbol;
        await this.fetchNftData(
          this._accounts[this._currentAccountIndex].data.balances.find(
            (b) => b.symbol == symbol
          )!
        );
      } catch (err) {
        console.error("Error fetching NFTs", err);
      }
    }

    console.log(
      "Refreshed account " +
      JSON.stringify(this._accounts[this._currentAccountIndex])
    );

    return this.persistWalletState(this._currentAccountIndex);
  }

  async authorizeDapp(
    dapp: string,
    hostname: string,
    token: string,
    expireDate: Date,
    version: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const account = this.currentAccount;
      if (!account) {
        reject();
        return;
      }

      const address = account.address;
      this._authorizations.push({
        dapp,
        hostname,
        token,
        address,
        expireDate: expireDate.getTime(),
        version
      });

      chrome.storage.local.set({ authorizations: this._authorizations }, () =>
        resolve()
      );
    });
  }

  getDapp(token: string): string {
    return this._authorizations.find((a) => a.token == token)!.dapp;
  }

  private async createProtectedWalletAccount(
    wif: string,
    password: string,
    accountData: Account
  ): Promise<WalletAccount> {
    if (!password) {
      throw new Error("Password is required to store a wallet in Ecto 2.0.0");
    }

    // The account record stays public/UI-only, while the vault keeps the
    // encrypted private key under the canonical address for that account.
    this._vault[accountData.address] = await protectWifWithPassword(wif, password);

    return {
      address: accountData.address,
      type: WalletAccountType.Protected,
      data: accountData,
    };
  }

  private async getWifFromAccount(
    account: WalletAccount,
    password: string
  ): Promise<string> {
    if (!password) {
      throw new Error(this.$i18n.t("error.noPasswordMatch").toString());
    }

    const protectedWif = this._vault[account.address];
    if (!protectedWif || !isProtectedWifPayload(protectedWif)) {
      throw new Error(this.$i18n.t("error.noEncrypted").toString());
    }

    let wif = "";
    // All password-based unlock, signing, and export flows go through this
    // single decrypt gate so the storage policy stays consistent everywhere.
    try {
      wif = await revealProtectedWifWithPassword(protectedWif, password);
    } catch {
      throw new Error(this.$i18n.t("error.noPasswordMatch").toString());
    }

    if (!this.isWifValidForAccount(wif, account)) {
      throw new Error(this.$i18n.t("error.noPasswordMatch").toString());
    }

    return wif;
  }

  async signTxWithPassword(
    txdata: TxArgsData,
    address: string,
    password: string
  ) {
    const account = this.accounts.find((a) => a.address == address);
    if (!account) throw new Error(this.$i18n.t("error.noAccount").toString());
    const wif = await this.getWifFromAccount(account, password);

    return await this.signTx(txdata, wif);
  }

  async signTx(txdata: TxArgsData, wif: string): Promise<string> {
    const account = this.currentAccount;
    if (!account) throw new Error(this.$i18n.t("error.notValid").toString());

    if (!this.isWifValidForAccount(wif))
      throw new Error(this.$i18n.t("error.noAccountMatch").toString());

    let dt = new Date();
    dt.setMinutes(dt.getMinutes() + 5);
    console.log(dt);

    const tx = new Transaction(
      txdata.nexus && txdata.nexus != '' ?  txdata.nexus : this.nexus,
      txdata.chain,
      txdata.script,
      dt,
      txdata.payload,
    );

    tx.sign(wif);

    const txHex = tx.toString(true)
    console.log("Signed ", txHex);
    const hash = await this.api.sendRawTransaction(txHex.toUpperCase());
    console.log("Returned from sendRawTransaction with res: ", hash);

    return hash;
  }

  async signCarbonTxWithPassword(
    txdata: TxMsg,
    address: string,
    password: string
  ) {
    const account = this.accounts.find((a) => a.address == address);
    if (!account) throw new Error(this.$i18n.t("error.noAccount").toString());
    const wif = await this.getWifFromAccount(account, password);

    return await this.signCarbonTx(txdata, wif);
  }

  async signCarbonTx(txdata: TxMsg, wif: string): Promise<string> {
    const account = this.currentAccount;
    if (!account) throw new Error(this.$i18n.t("error.notValid").toString());
    if (!this.isWifValidForAccount(wif))
      throw new Error(this.$i18n.t("error.noAccountMatch").toString());

    const keys = PhantasmaKeys.fromWIF(wif);
    const bytes = TxMsgSigner.signAndSerialize(txdata, keys);

    const txHex = bytesToHex(bytes);
    console.log("Signed ", txHex);
    const hash = await this.api.sendCarbonTransaction(txHex.toUpperCase());
    console.log("Returned from sendRawTransaction with res: ", hash);
    return hash;
  }

  async signDataWithPassword(
    data: string,
    address: string,
    password: string
  ): Promise<string> {
    const account = this.accounts.find((a) => a.address == address);
    if (!account) throw new Error(this.$i18n.t("error.noAccount").toString());
    const wif = await this.getWifFromAccount(account, password);

    return this.signData(data, wif);
  }

  signData(data: string, wif: string): string {
    const account = this.currentAccount;
    if (!account) throw new Error(this.$i18n.t("error.notValid").toString());

    if (!this.isWifValidForAccount(wif))
      throw new Error(this.$i18n.t("error.noAccountMatch").toString());

    const privateKey = getPrivateKeyFromWif(wif);

    return signData(data, privateKey);
  }

  async getWifFromPassword(
    password: string,
    acc: WalletAccount | undefined = undefined
  ): Promise<string> {
    const account = acc !== undefined ? acc : this.currentAccount;
    if (!account) throw new Error(this.$i18n.t("error.noAccount").toString());

    return this.getWifFromAccount(account, password);
  }

  getAllTokens(): Token[] {
    return (this._tokens as any)[this.nexus] as Token[];
  }

  getToken(symbol: string) {
    return this.getAllTokens().find((t) => t.symbol == symbol);
  }

  decimals(symbol: string): number {
    const token = this.getToken(symbol);
    if (token) return token.decimals;

    switch (symbol) {
      case "KCAL":
        return 10;
      case "SOUL":
        return 8;
      case "NEO":
        return 0;
      case "GAS":
        return 8;
      case "GOATI":
        return 3;
      case "ETH":
        return 18;
      case "MKNI":
        return 0;
      case "DYT":
        return 18;
      case "MUU":
        return 18;
      case "DANK":
        return 18;
      case "USDC":
        return 6;
      case "BNB":
        return 18;
      case "BUSD":
        return 18;
      case "GM":
        return 8;
      case "WNDR":
        return 8;
      case "NKTR":
        return 8;
      default:
        return 0;
    }
  }

  isNFT(symbol: string) {
    const token = this.getToken(symbol);
    return token && token.flags && !token.flags.includes("Fungible");
  }

  isBurnable(symbol: string) {
    const token = this.getToken(symbol);
    return token && token.flags && token.flags.includes("Burnable");
  }

  formatBalance(symbol: string, amount: string): string {
    const decimals = this.decimals(symbol);
    if (this.isNFT(symbol)) return symbol + " NFT";

    if (decimals == 0) return amount + " " + symbol;
    while (amount.length < decimals + 1) amount = "0" + amount;

    const intPart = amount.substring(0, amount.length - decimals);
    const decimalPart = amount.substring(
      amount.length - decimals,
      amount.length
    );
    if (parseInt(decimalPart) == 0) return intPart + " " + symbol;
    return (
      intPart +
      "." +
      (decimalPart.length >= 2 ? decimalPart.substring(0, 2) : decimalPart) +
      " " +
      symbol
    );
  }

  async getAccountTransactions(
    address: string,
    offsetPage: number = 0
  ): Promise<Paginated<AccountTransactions>> {
    return await this.api.getAddressTransactions(address, offsetPage + 1, 15);
  }

  async fetchNftData(balance: Balance) {
    if (!balance) return;
    const token = balance.symbol;
    const ids = balance.ids;
    if (!ids) return;

    await this.queryNfts(ids, token);
  }

  async queryNfts(ids: string[], token: string) {
    const allNftsToQuery = [];
    console.log('ids', ids, 'token', token)
    
    for (let k = 0; k < ids.length; ++k) {
      const id = ids[k];
      const lookupId = token + "@" + id;
      const nft = this.nfts[lookupId];
      console.log('nft', nft)
      if (!nft || !nft.img || nft.img=="" || nft.img.startsWith("placeholder-")) {
        // search for it
        allNftsToQuery.push(id);
      }
    }

    if (token == "TTRS") {
      const host = "https://www.22series.com/api/store/nft";

      // batch query TTRS tokens
      for (let i = 0; i < allNftsToQuery.length; i += 100) {
        const nftsToQuery = allNftsToQuery.slice(i, i + 100);

        console.log("querying", nftsToQuery);

        const res = await fetch(host, {
          method: "POST",
          mode: "cors",
          body: JSON.stringify({ ids: nftsToQuery }),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        let nftsTtrs = await res.json();
        console.log("Result of queryNft", nftsToQuery, nftsTtrs);
        let nftDict: any = {};

        Object.keys(nftsTtrs).forEach((key) => {
          const ttrs = nftsTtrs[key];
          let nftDef = {
            id: key,
            mint: ttrs.mint,
            img: ttrs.img + "?width=128",
            type: ttrs.type,
            name: ttrs.item_info.name_english,
            rarity: ttrs.item_info.rarity,
          };
          nftDict[token + "@" + key] = nftDef;
        });
        Object.assign(this.nfts, nftDict);
      }
    } else {
      // query nfts individually
      let nftDict: any = {};

      for (let i = 0; i < allNftsToQuery.length; ++i) {
        const nftId = allNftsToQuery[i];
        console.log("getNFT of " + token + " " + nftId);
        const nft = await this.api.getNFT(token, nftId);
        console.log("Got nft", nft);

        const imgUrlUnformated = nft.properties.find(
          (kv) => kv.key == "imageURL"
        )?.value;

        let nftDef = {
          id: nftId,
          carbonTokenId: nft.carbonTokenId,
          carbonNftAddress: nft.carbonNftAddress,
          mint: nft.mint,
          img: imgUrlUnformated,
          type: nft.properties.find((kv) => kv.key == "type")?.value,
          name: nft.properties.find((kv) => kv.key == "name")?.value,
          infusion: nft.infusion,
        };
        console.log('')
        nftDict[token + "@" + nftId] = nftDef;
      }
      Object.assign(this.nfts, nftDict);
    }

    this.nfts = Object.assign({}, this.nfts);

    if (allNftsToQuery.length > 0)
      chrome.storage.local.set({ nfts: this.nfts }, () => { });
  }
}

export const state = new PopupState();
