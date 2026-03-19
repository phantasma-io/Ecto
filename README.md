## ecto

For local testing, enable developer mode in `chrome://extensions` or `brave://extensions` and use `Load unpacked` on the `dist/` folder.

## Project setup
```
npm install
```

or

```
just install
```

### Compiles and hot-reloads for development
```
npm run build-watch
```

### Compiles and minifies for production
```
npm run build
```

or

```
just build
```

### Builds a shareable unpacked archive
```
just package
```

This writes a zip like `artifacts/ecto-2.0.0-unpacked.zip`.
The tester must unzip it first, then load the unpacked folder from the browser extensions page.

### Prints the current extension ID derived from manifest key
```
just extension-id
```

### Lints and fixes files
```
npm run lint
```

### Customize configuration
See [Configuration Reference](https://cli.vuejs.org/config/).
