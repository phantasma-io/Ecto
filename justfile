set shell := ["bash", "-euo", "pipefail", "-c"]

version := `node -p "require('./package.json').version"`
archive := "artifacts/ecto-" + version + "-unpacked.zip"

default:
    @just --list

install:
    npm install

build:
    npm run build

package:
    rm -rf dist artifacts
    npm run build
    mkdir -p artifacts
    (cd dist && zip -qr ../{{archive}} .)
    sha256sum {{archive}}

extension-id:
    @python -c 'import base64, hashlib, json, pathlib; manifest = json.loads(pathlib.Path("src/manifest.production.json").read_text()); public_key_der = base64.b64decode(manifest["key"]); digest = hashlib.sha256(public_key_der).hexdigest()[:32]; print(digest.translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop")))'
