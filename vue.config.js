const CopyWebpackPlugin = require("copy-webpack-plugin");
const webpack = require("webpack");
const path = require("path");

// Generate pages object
const pagesObj = {};

const chromeName = ["popup", "options", "content_script", "background", "inpage"];

chromeName.forEach(name => {
  pagesObj[name] = {
    entry: `src/${name}/index.ts`,
    template: "public/index.html",
    filename: `${name}.html`
  };
});

const plugins =
  process.env.NODE_ENV === "production"
    ? [
        {
          from: path.resolve("src/manifest.production.json"),
          to: `${path.resolve("dist")}/manifest.json`,
          toType: "file"
        }
      ]
    : [
        {
          from: path.resolve("src/manifest.development.json"),
          to: `${path.resolve("dist")}/manifest.json`,
          toType: "file"
        }
      ];

module.exports = {
  pages: pagesObj,
  transpileDependencies: ['phantasma-sdk-ts'],
  configureWebpack: config => {
    config.plugins.push(new CopyWebpackPlugin({ patterns: plugins }));
    config.plugins.push(
      new webpack.ProvidePlugin({
        process: 'process/browser',
        Buffer: ['buffer', 'Buffer']
      })
    );
    config.output.filename = 'js/[name].js';
    config.output.chunkFilename = 'js/[name].js';
    // `crypto-browserify` pulls an optional `vm` dependency through `asn1.js`.
    // We do not want a dead browser polyfill for that Node module in the extension bundle.
    config.resolve.fallback = {
      crypto: require.resolve('crypto-browserify'),
      stream: require.resolve('stream-browserify'),
      buffer: require.resolve('buffer/'),
      vm: false
    };
  },
  chainWebpack: config => {
    // Disable TypeScript type checking during build
    config.plugins.delete('fork-ts-checker');
    
    config.plugin('copy')
          .tap(args => {
            args[0].patterns.push({
              from: path.resolve(__dirname, 'src/_locales'),
              to: path.resolve(__dirname, 'dist/_locales'),
              toType: 'dir',
              globOptions: {
                ignore: ['.DS_Store']
              }
            })
            return args
          })
  }
};
