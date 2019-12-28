module.exports = {
  name: "maixduino-actionbar",
  title: "Maixduino actionbar",
  description: "Actionbar setting menu for maixduino",
  auther: "Comdet Pheaudphut X Sonthaya Nongnuch",
  website: "https://wwww.ioxgb.com/",
  git: "",
  image: "",
  version: "1.0.0",
  components: [
    "actionbar-just-compile",
    "actionbar-build",
    "actionbar-setting",
  ],
  data: {
    wifi_ssid: "",
    wifi_password: "",
    comport: "",
    baudrate: 2000000,
    cflag: "",
    loaded: false, //this will automatic set to 'true' if this pacakage loaded to IDE
  },
  persistence: {
    test: true,
  },
};
