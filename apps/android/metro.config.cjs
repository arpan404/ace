const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
config.maxWorkers = 4;
module.exports = config;
