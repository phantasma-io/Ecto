/// <reference types="chrome"/>
import { PhantasmaAPI } from "@/phan-js"; // we need this version as XmlHttpRequest is not available in service worker

type WalletAccount = any;

interface IAuthorization {
  dapp: string;
  hostname: string;
  token: string;
  address: string;
  expireDate: number;
  version: string | undefined;
}

interface IWalletLinkResponse {
  id: number;
  success: boolean;
}

interface IBalance {
  symbol: string;
  value: string;
  decimals: number;
}

interface IGetAccountResponse extends IWalletLinkResponse {
  address: string;
  name: string;
  avatar: string;
  balances: IBalance[];
  platform: string | undefined;
  external?: string | undefined;
}

function getStorageItems(keys: string[]): Promise<{ [key: string]: any }> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(items);
      }
    });
  });
}

async function getAuthorizations(): Promise<IAuthorization[]> {
  const items = await getStorageItems(["authorizations"]);
  return items.authorizations ? items.authorizations : [];
}

async function currentAccount(): Promise<WalletAccount | null> {
  const items = await getStorageItems(["accounts", "currentAccountIndex"])
  const accounts = items.accounts ? items.accounts : [];
  const currentAccountIndex = items.currentAccountIndex ? items.currentAccountIndex : 0;
  return currentAccountIndex < accounts.length ? accounts[currentAccountIndex] : null;
}

chrome.tabs.onUpdated.addListener(function (activeInfo) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs[0];
    const tabURL = tab.url;

    if (!tabURL || tab.status=='loading') return;
    if (tabURL.startsWith("chrome")) return;

    if (tab.id)
      chrome.tabs.sendMessage(
        tab.id,
        { uid: "init", tabid: tab.id },
        () => {}
      );
  });
});

function genHexString(len: number) {
  let output = "";
  for (let i = 0; i < len; ++i) {
    output += Math.floor(Math.random() * 16).toString(16);
  }
  return output;
}

async function getAuthorizationToken(
  dapp: string,
  hostname: string,
  version: string
): Promise<string | undefined> {
  // remove first all authorizations that are expired
  const now = new Date();
  const authorizations = await getAuthorizations();
  const validAuths = authorizations.filter((a) => new Date(a.expireDate) > now);

  if (validAuths.length != authorizations.length) {
    chrome.storage.local.set({ authorizations: validAuths }, () => { });
  }

  const auth = validAuths.find((a) => {
    if (version == "2")
      return a.dapp == dapp && a.hostname == hostname && a.version == "2";
    else return a.dapp == dapp && a.hostname == hostname;
  });
  if (!auth) return undefined;

  return auth.token;
}

async function isValidRequest(args: string[]): Promise<boolean> {
  if (args.length >= 3) {
    // const dapp = args[args.length - 2];
    const token = args[args.length - 1];
    const authorizations = await getAuthorizations();
    const auth = authorizations.find((a) => a.token == token);
    return auth != undefined;
  }
  return false;
}

async function getAddressFromToken(token: string): Promise<string | undefined> {
  const authorizations = await getAuthorizations();
  const auth = authorizations.find((a) => a.token == token);
  return auth?.address;
}

async function getRequestAddress(
  args: string[]
): Promise<{ address: string; version: string } | undefined> {
  if (args.length >= 3) {
    const dapp = args[args.length - 2];
    const token = args[args.length - 1];
    const authorizations = await getAuthorizations();
    const auth = authorizations.find((a) => a.token == token);
    return auth
      ? { address: auth.address, version: auth.version ? auth.version : "1" }
      : undefined;
  }
}

chrome.runtime.onMessage.addListener(async function (msg, sender, sendResponse) {

  console.log('[sw] Received msg', msg, 'from', sender)

  if (msg.uid == "plsres") {
    console.log(JSON.stringify(msg));
    chrome.tabs.sendMessage(msg.tabid, msg);
  }

  if (msg.uid == "pls") {
    let args: string[] = msg.data.split(",");

    const id = parseInt(args[0]);
    if (args.length != 2) {
      throw Error("Invalid message format");
    }

    let cmd = args[1];
    args = cmd.split("/");

    const requestType = args[0];
    console.log("[sw] Received " + requestType + " with tabid " + msg.tabid);

    const {nexus, rpc} = await getStorageItems(["nexus", "rpc"])
    const api = new PhantasmaAPI(rpc, undefined as any)

    switch (requestType) {
      case "authorize":
        {
          const token = genHexString(64);
          const dapp = args[1];

          console.log('authorize', args)
          const version = args.length > 2 ? args[2] : "1";
          console.log('version', version)

          chrome.tabs.get(msg.tabid, async (tab) => {
            const url = tab.url || "http://unknown";
            const favicon = tab.favIconUrl || "unknown";

            let authToken = await getAuthorizationToken(
              dapp,
              new URL(url).hostname,
              version
            );

            const addressFromToken = authToken ? await getAddressFromToken(authToken) : undefined;
            const curAccount = await currentAccount();

            // if authorization doesn't match current address, request new one
            if (
              authToken &&
              getAddressFromToken(authToken) !== curAccount?.address
            ) {
              authToken = undefined;
            }

            if (authToken) {
              console.log("Valid authorization token: " + authToken);

              chrome.tabs.sendMessage(msg.tabid, {
                uid: "plsres",
                tabid: msg.tabid,
                sid: msg.sid,
                data: {
                  wallet: "Ecto",
                  dapp,
                  token: authToken,
                  // new in v2
                  nexus: nexus,
                  version: "2",
                  id,
                  success: true,
                },
              });

              return;
            } else
              chrome.windows.create(
                {
                  type: "popup",
                  url:
                    "popup.html?/#/Authorize/" +
                    dapp +
                    "/" +
                    token +
                    "/" +
                    id +
                    "/" +
                    msg.tabid +
                    "/" +
                    msg.sid +
                    "/" +
                    btoa(url).replace(/\//g, '_') +
                    "/" +
                    btoa(favicon).replace(/\//g, '_') +
                    "/" +
                    version
                  ,
                  width: 320,
                  height: 600,
                },
                (wnd) => {
                  console.log("created popup wnd");
                }
              );
          });
        }
        break;

      case "getAccount":
        console.log('[sw] getAccount', args)
        if (await isValidRequest(args)) {
          const req = await getRequestAddress(args);
          if (req == null) return;
          const address = req.address;
          const version = req.version;

          let platform = "phantasma";
          if (args.length > 3) {
            platform = args[1];
            /// check that this is ok
          }

          console.log("getting account " + address);
          let account = await api.getAccount(address);
          if (!account.balances) {
            account.balances = [];
          }

          if (!account.balances.find((b) => b.symbol == "SOUL"))
            account.balances.unshift({
              chain: "main",
              symbol: "SOUL",
              amount: "0",
              decimals: 8,
            });

          // make sure SOUL and KCAL are first
          account.balances = account.balances.sort((a, b) => {
            if (a.symbol == "SOUL") return -1;
            if (b.symbol == "SOUL") return 1;
            if (a.symbol == "KCAL") return -1;
            if (b.symbol == "KCAL") return 1;
            return 0;
          });

          let balances:any = account.balances.map((x) => {
            return {
              value: x.amount,
              decimals: x.decimals,
              symbol: x.symbol,
              ids: x.ids
            };
          });

          platform = "phantasma";  // force phantasma for now

          console.log("got account: " + JSON.stringify(account));
          let response: IGetAccountResponse = {
            name: account.name,
            address: account.address,
            avatar: "",
            platform,
            balances,
            id,
            success: true,
          };
          console.log("sending account response" + JSON.stringify(response));
          chrome.tabs.sendMessage(msg.tabid, {
            uid: "plsres",
            sid: msg.sid,
            data: response,
          });
        }
        else {
          console.log('[sw] not valid request for getAccount')
        }

        break;

      case "signTx":
        if (await isValidRequest(args)) {
          const req = await getRequestAddress(args);
          if (req == null) return;
          const address = req.address;
          const version = req.version;
          const token = args[args.length - 1];

          let nexusTx = "";
          let payload = "";
          let chain = "";
          let script = "";
          let platform = "phantasma";
          let signature = "Ed25519";
          let pow = "None";

          if (version == "1") {
            nexusTx = args[1];
            chain = args[2];
            script = args[3];
            payload = args[4];
          } else if (version == "2") {
            chain = args[1];
            script = args[2];
            payload = args[3];
            signature = args[4];
            platform = args[5];
            if (args.length > 6+2) pow = args[6]

            console.log('pow', pow)
          }

          payload = payload == null || payload == "" ? "undef" : payload;

          let txdata = JSON.stringify({
            nexus: nexusTx,
            chain,
            script,
            payload,
            signature,
            platform,
          });
          let b64txdata = btoa(txdata).replace(/\//g, '_');

          chrome.tabs.get(msg.tabid, (tab) => {
            const url = tab.url || "http://unknown";
            const favicon = tab.favIconUrl || "unknown";

            console.log("[sw] Creating sign popup with " + txdata);
            chrome.windows.create(
              {
                type: "popup",
                url:
                  "popup.html?/#/Sign/" +
                  token +
                  "/" +
                  id +
                  "/" +
                  msg.tabid +
                  "/" +
                  msg.sid +
                  "/" +
                  btoa(url).replace(/\//g, '_') +
                  "/" +
                  btoa(favicon).replace(/\//g, '_') +
                  "/" +
                  b64txdata,
                width: 320,
                height: 600,
              },
              (wnd) => { }
            );
          });
        }

        break;

      case "signData":
        if (await isValidRequest(args)) {
          const req = await getRequestAddress(args);
          if (req == null) return;
          const address = req.address;
          const version = req.version;
          const token = args[args.length - 1];

          const hexdata = args[1];
          const signKind = args[2];
          let platform = "phantasma";

          if (version == "2" && args.length > 3)
            platform = args[3].toLocaleLowerCase();

          chrome.tabs.get(msg.tabid, (tab) => {
            const url = tab.url || "http://unknown";
            const favicon = tab.favIconUrl || "unknown";

            console.log("[sw] Creating signData popup with " + hexdata);
            chrome.windows.create(
              {
                type: "popup",
                url:
                  "popup.html?/#/SignData/" +
                  token +
                  "/" +
                  id +
                  "/" +
                  msg.tabid +
                  "/" +
                  msg.sid +
                  "/" +
                  btoa(url).replace(/\//g, '_') +
                  "/" +
                  btoa(favicon).replace(/\//g, '_') +
                  "/" +
                  hexdata,
                width: 320,
                height: 600,
              },
              (wnd) => { }
            );
          });
        }

        break;

      case "invokeScript":
        if (await isValidRequest(args)) {
          let chain = args[1]
          let script = args[2];
          console.log('[sw] invokeScript', chain, script)
          const response = await api.invokeRawScript(chain, script)
          console.log('[sw] invokeScript response: ', response)

          chrome.tabs.sendMessage(msg.tabid, {
            uid: "plsres",
            sid: msg.sid,
            data: { result: response.result, results: response.results, id, success: true},
          });

        }
        break;

      case "getPeer":
        console.log('[sw] getPeer returning ', api.host)
        chrome.tabs.sendMessage(msg.tabid, {
          uid: "plsres",
          sid: msg.sid,
          data: { result: api.host, id, success: true},
        });
        break;

      case "getNexus":
        console.log('[sw] getNexus returning ', nexus)
        chrome.tabs.sendMessage(msg.tabid, {
          uid: "plsres",
          sid: msg.sid,
          data: { result: nexus, id, success: true},
        });
        break;
    }
  }
  sendResponse({ success: true });
});
