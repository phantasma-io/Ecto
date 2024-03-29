/// <reference types="chrome"/>
import Vue from "vue";
import { PhantasmaAPI } from "@/phan-js";
import { state, WalletAccount } from "@/popup/PopupState";
import VueI18n from "vue-i18n";
import { messages, defaultLocale } from "@/i18n";
import { getEthBalances } from "@/ethereum";
import { getNeoBalances } from "@/neo";
import { getBscBalances } from "@/bsc";

Vue.use(VueI18n);

const powValues = {
  None : 0,
  Minimal : 5,
  Moderate : 15,
  Hard : 19,
  Heavy : 24,
  Extreme : 30
}

const i18n = new VueI18n({
  messages,
  locale: defaultLocale,
  fallbackLocale: defaultLocale,
});

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

interface IAuthorizeResponse extends IWalletLinkResponse {
  wallet: string;
  dapp: string;
  token: string;
}

interface IGetAccountResponse extends IWalletLinkResponse {
  address: string;
  name: string;
  avatar: string;
  balances: IBalance[];
  platform: string | undefined;
  external: string | undefined;
}

interface ISignTxResponse extends IWalletLinkResponse {
  hash: string;
}

let authorizations: IAuthorization[] = [];
let accounts: WalletAccount[] = [];
let currentAccountIndex = 0;

function currentAccount() {
  return currentAccountIndex < accounts.length
    ? accounts[currentAccountIndex]
    : null;
}

chrome.tabs.onUpdated.addListener(function (activeInfo) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const tab = tabs[0];
    const tabURL = tab.url;

    if (!tabURL) return;

    if (tab.id)
      chrome.tabs.sendMessage(
        tab.id,
        { uid: "init", tabid: tab.id },
        function () {
          console.log(tab.id);
        }
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

function getAuthorizationToken(
  dapp: string,
  hostname: string,
  version: string
): string | undefined {
  // remove first all authorizations that are expired
  const now = new Date();
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

function isValidRequest(args: string[]): boolean {
  if (args.length >= 3) {
    // const dapp = args[args.length - 2];
    const token = args[args.length - 1];

    const auth = authorizations.find((a) => a.token == token);
    return auth != undefined;
  }
  return false;
}

function getAddressFromToken(token: string): string | undefined {
  const auth = authorizations.find((a) => a.token == token);
  return auth?.address;
}

function getRequestAddress(
  args: string[]
): { address: string; version: string } | undefined {
  if (args.length >= 3) {
    const dapp = args[args.length - 2];
    const token = args[args.length - 1];
    const auth = authorizations.find((a) => a.token == token);
    return auth
      ? { address: auth.address, version: auth.version ? auth.version : "1" }
      : undefined;
  }
}

chrome.storage.local.get((items) => {
  authorizations = items.authorizations ? items.authorizations : [];
  currentAccountIndex = items.currentAccountIndex
    ? items.currentAccountIndex
    : 0;
  accounts = items.accounts
    ? items.accounts.filter((a: WalletAccount) => a.type !== "wif")
    : [];
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area == "local") {
    if (changes.authorizations) {
      authorizations = changes.authorizations.newValue;
    }
    if (changes.accounts) {
      accounts = changes.accounts.newValue;
    }
    if (changes.currentAccountIndex) {
      currentAccountIndex = changes.currentAccountIndex.newValue;
    }
  }
});

chrome.runtime.onMessage.addListener(async function (msg, sender, sendResponse) {
  i18n.locale = state.locale;

  if (msg.uid == "plsres") {
    console.log(JSON.stringify(msg));
    chrome.tabs.sendMessage(msg.tabid, msg);
  }

  if (msg.uid == "pls") {
    let args: string[] = msg.data.split(",");

    const id = parseInt(args[0]);
    if (args.length != 2) {
      throw Error(i18n.t("error.malformed").toString());
    }

    let cmd = args[1];
    args = cmd.split("/");

    const requestType = args[0];
    console.log(
      "[background] Received " + requestType + " with tabid " + msg.tabid
    );

    switch (requestType) {
      case "authorize":
        {
          const token = genHexString(64);
          const dapp = args[1];

          console.log('authorize', args)
          const version = args.length > 2 ? args[2] : "1";
          console.log('version', version)

          chrome.tabs.get(msg.tabid, (tab) => {
            const url = tab.url || "http://unknown";
            const favicon = tab.favIconUrl || "unknown";

            let authToken = getAuthorizationToken(
              dapp,
              new URL(url).hostname,
              version
            );

            // if authorization doesn't match current address, request new one
            if (
              authToken &&
              getAddressFromToken(authToken) !== currentAccount()?.address
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
                  nexus: state.nexus,
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
        if (isValidRequest(args)) {
          const req = getRequestAddress(args);
          if (req == null) return;
          const address = req.address;
          const version = req.version;

          let platform = "phantasma";
          if (args.length > 3) {
            platform = args[1];
            /// check that this is ok
          }

          await state.check(undefined);
          console.log("nexus", state.nexus);
          console.log("getting account " + address);
          let account = await state.api.getAccount(address);
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

          let balances:any = account.balances.map((x) => {
            return {
              value: x.amount,
              decimals: x.decimals,
              symbol: x.symbol,
              ids: x.ids
            };
          });

          let external = ""; // external address (neo or eth or bsc) if platform is not phantasma

          const curAccount = currentAccount();
          if (platform == "bsc") {
            let bscAddress = curAccount?.bscAddress;
            if (bscAddress) {
              external = bscAddress;
              const bscBals = await getBscBalances(
                bscAddress,
                state.nexus == "mainnet"
              );
              balances = bscBals.map((b: any) => {
                return {
                  symbol: b.symbol,
                  value: b.amount.toString(),
                  decimals: state.decimals(b.symbol),
                };
              });
            } else {
              platform = "phantasma";
            }
          }

          if (platform == "ethereum") {
            let ethAddress = curAccount?.ethAddress;
            if (ethAddress) {
              external = ethAddress;
              const ethBals = await getEthBalances(
                ethAddress,
                state.nexus == "mainnet"
              );
              balances = ethBals.map((b: any) => {
                return {
                  symbol: b.symbol,
                  value: b.amount.toString(),
                  decimals: state.decimals(b.symbol),
                };
              });
            } else {
              platform = "phantasma";
            }
          }

          if (platform == "neo") {
            let neoAddress = curAccount?.neoAddress;
            if (neoAddress) {
              external = neoAddress;
              const neoBals = await getNeoBalances(
                neoAddress,
                state.nexus == "mainnet"
              );
              balances = neoBals.map((b: any) => {
                return {
                  symbol: b.symbol,
                  value: b.amount,
                  decimals: state.decimals(b.symbol),
                };
              });
            } else {
              platform = "phantasma";
            }
          }

          console.log("got account: " + JSON.stringify(account));
          let response: IGetAccountResponse = {
            name: account.name,
            address: account.address,
            avatar: "",
            platform,
            external,
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
        break;

      case "signTx":
        if (isValidRequest(args)) {
          const req = getRequestAddress(args);
          if (req == null) return;
          const address = req.address;
          const version = req.version;
          const token = args[args.length - 1];

          let nexus = "";
          let payload = "";
          let chain = "";
          let script = "";
          let platform = "phantasma";
          let signature = "Ed25519";
          let pow = "None";

          if (version == "1") {
            nexus = args[1];
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

          payload = payload == null || payload == "" ? state.payload : payload;

          let txdata = JSON.stringify({
            nexus,
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

            console.log("[background] Creating sign popup with " + txdata);
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
        if (isValidRequest(args)) {
          const req = getRequestAddress(args);
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

            console.log("[background] Creating signData popup with " + hexdata);
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
        if (isValidRequest(args)) {
          let chain = args[1]
          let script = args[2];

          const response = await state.api.invokeRawScript(chain, script)
          console.log('invokeScript', response)

          chrome.tabs.sendMessage(msg.tabid, {
            uid: "plsres",
            sid: msg.sid,
            data: { result: response.result, results: response.results, id, success: true},
          });

        }
        break;

      case "getPeer":
        await state.check(undefined);

        chrome.tabs.sendMessage(msg.tabid, {
          uid: "plsres",
          sid: msg.sid,
          data: { result: state.api.host, id, success: true},
        });
        break;

      case "getNexus":
        await state.check(undefined);

        chrome.tabs.sendMessage(msg.tabid, {
          uid: "plsres",
          sid: msg.sid,
          data: { result: state.nexus, id, success: true},
        });
        break;
    }
  }
  return Promise.resolve("Dummy response to keep the console quiet");
});
