const util = require("util");
const fs = require("fs");
const path = require("path");
const execPromise = util.promisify(require("child_process").exec);
const { exec, execFile } = require("child_process");
const engine = Vue.prototype.$engine;
const { default: PQueue } = engine.util.requireFunc("p-queue");
const GB = Vue.prototype.$global;
const mkdirp = engine.util.requireFunc("mkdirp");

const md5File = require("./md5-file");

//---- setup dir and config ----//
let platformName = "maixduino";
let platformDir = `${engine.util.platformDir}/${platformName}`;
let platformLibDir = `${platformDir}/lib`;

const log = msg => {
  console.log(`[maixduino] : ${msg}`);
  GB.$emit("compile-log",`[maixduino] : ${msg}`);
};

const ospath = function(p) {
  if (process.platform == "win32") {
    return p.replace(/\//g, "\\");
  }
  return p;
};

const getName = (file) => path.basename(file).split(".")[0];
const getFileName = (file) => path.basename(file);

var G = {};
var buildFirstTime = true;
var sourceFileMD5 = { };
var coreChange = false;

var boardDirectory;

const setConfig = (context) => {
  let localContext = JSON.parse(fs.readFileSync(`${platformDir}/context.json`, "utf8"));
  G = Object.assign({}, localContext);
  G.board_name = context.board_name;   //require boardname
  G.app_dir = context.app_dir;         //require app_dir
  G.process_dir = context.process_dir; //require working dir
  G.cb = context.cb || function() {};
  G.board_context = context.board_context;

  if (!G.cpp_options) {
    G.cpp_options = [];
  }
  
  G.preprocflags = G.preprocflags.map(f => f.replace(/\{platform\}/g, platformDir));
  G.preprocflags = G.preprocflags.map(f => f.replace(/\{board\}/g, boardDirectory));
  G.preprocflags = G.preprocflags.join(" ");
  
  G.bothflags = G.bothflags.join(" ");
  
  G.debugflags = G.debugflags.join(" ");

  G.cflags = G.cflags.map(f => f.replace(/\{debugflags\}/g, G.debugflags));
  G.cflags = G.cflags.map(f => f.replace(/\{bothflags\}/g, G.bothflags));
  G.cflags = G.cflags.map(f => f.replace(/\{preprocflags\}/g, G.preprocflags));
  
  G.cppflags = G.cppflags.map(f => f.replace(/\{debugflags\}/g, G.debugflags));
  G.cppflags = G.cppflags.map(f => f.replace(/\{bothflags\}/g, G.bothflags));
  G.cppflags = G.cppflags.map(f => f.replace(/\{preprocflags\}/g, G.preprocflags));
  
  G.Sflags = G.Sflags.map(f => f.replace(/\{debugflags\}/g, G.debugflags));
  G.Sflags = G.Sflags.map(f => f.replace(/\{bothflags\}/g, G.bothflags));
  G.Sflags = G.Sflags.map(f => f.replace(/\{preprocflags\}/g, G.preprocflags));
  
  G.ldflags = G.ldflags.map(f => f.replace(/\{platform\}/g, platformDir));
  G.ldlibflag = G.ldlibflag.map(f => f.replace(/\{platform\}/g, platformDir));

  G.COMPILER_AR = `${platformDir}/${G.gcc_dir}/riscv64-unknown-elf-ar`;
  G.COMPILER_GCC = `${platformDir}/${G.gcc_dir}/riscv64-unknown-elf-gcc`;
  G.COMPILER_CPP = `${platformDir}/${G.gcc_dir}/riscv64-unknown-elf-g++`;
  G.COMPILER_OBJCOPY = `${platformDir}/${G.gcc_dir}/riscv64-unknown-elf-objcopy`;

  G.COMPILER_KFLASH = `${platformDir}/tools/kflash/kflash${(process.platform === "win32" || process.platform === "darwin") ? '_py' : '.py'}`;

  G.ELF_FILE = `${G.app_dir}/${G.board_name}.elf`;
  G.BIN_FILE = `${G.app_dir}/${G.board_name}.bin`;
  G.ARCHIVE_FILE = `${G.app_dir}/core.a`;
};
//=====================================//

function compile(rawCode, boardName, config, cb) {
  return new Promise((resolve, reject) => {
    //---- setup dir and config ----//
    boardDirectory = `${engine.util.boardDir}/${GB.board.board_info.name}`;
    let platformDirectory = `${engine.util.platformDir}/${GB.board.board_info.platform}`;
    let boardIncludeDir = `${boardDirectory}/include`;
    let platformIncludeDir = `${platformDirectory}/cores`;
    let context = JSON.parse(fs.readFileSync(boardDirectory + "/context.json", "utf8"));

    log(`compiler.compile platformDir = ${platformDirectory}`);
    //--- init ---//
    let codegen = null;
    if (fs.existsSync(`${boardDirectory}/codegen.js`)) {
      codegen = require(`${boardDirectory}/codegen.js`);
    } else {
      codegen = engine.util.requireFunc(`${platformDirectory}/codegen`);
    }
    //---- inc folder ----//
    let app_dir = `${boardDirectory}/build/${boardName}`;
	
    let inc_src = engine.util.walk(boardIncludeDir)
      .filter(file => path.extname(file) === ".cpp" || path.extname(file) === ".c" || path.extname(file) === ".S");
    inc_src = inc_src.concat(engine.util.walk(platformIncludeDir)
      .filter(file => path.extname(file) === ".cpp" || path.extname(file) === ".c" || path.extname(file) === ".S"));
	
	// console.log(inc_src);
	
    let inc_switch = [];
    //--- step 1 load template and create full code ---//
    let sourceCode = null
    let codeContext = null;
    if (config.isSourceCode) {
      sourceCode = rawCode;
      //searching all include to find matched used plugin file
      codeContext = {
        plugins_sources: [],
        plugins_includes_switch: [],
      };
      let pluginInfo = GB.plugin.pluginInfo;
      let incsRex = /#include\s*(?:\<|\")(.*?\.h)(?:\>|\")/gm;
      let m;
      while (m = incsRex.exec(sourceCode)) {
        let incFile = m[1].trim();
        //lookup plugin exist inc file and not added to compiled files.
        let includedPlugin = pluginInfo.categories.find(
          obj=>
            obj.sourceFile.includes(incFile) &&
            !codeContext.plugins_includes_switch.includes(obj.sourceIncludeDir)
        );
        if (includedPlugin) {
          log("Include Plugin to compiler => " + includedPlugin.category.name);
          codeContext.plugins_includes_switch.push(includedPlugin.sourceIncludeDir);
          let cppFiles = includedPlugin.sourceFile
            .filter(el=>el.endsWith(".cpp") || el.endsWith(".c"))
            .map(el=>includedPlugin.sourceIncludeDir + "/" +el);
          codeContext.plugins_sources.push(cppFiles);
        }
      }
    } else {
      let res = codegen.generate(rawCode);
      sourceCode = res.sourceCode;
      codeContext = res.codeContext;
    }
	
    //----- plugin file src ----//
    inc_src = inc_src.concat(codeContext.plugins_sources);
    inc_switch = inc_switch.concat(codeContext.plugins_includes_switch);
	
    //------ clear build folder and create new one (One time) --------//
	if (buildFirstTime) {
      if (fs.existsSync(app_dir)) {
        engine.util.rmdirf(app_dir);
      }
      mkdirp.sync(app_dir);
	  
	  buildFirstTime = false;
	}
    //-----------------------------------------------------//
    fs.writeFileSync(`${app_dir}/user_app.cpp`, sourceCode, "utf8");
	
    //--- step 3 load variable and flags ---//
    let cflags = [];
    let ldflags = [];
    let libflags = [];
    if (context.cflags) {
      cflags = context.cflags.map(f => f.replace(/\{board\}/g, boardDirectory));
    }
    if (context.ldflags) {
      ldflags = context.ldflags.map(f => f.replace(/\{board\}/g, boardDirectory));
    }
    if (context.libflags) {
      libflags = context.libflags.map(f => f.replace(/\{board\}/g, boardDirectory));
    }
	
    //--- step 4 compile
    let contextBoard = {
      board_name: boardName,
      app_dir: app_dir,
      process_dir: boardDirectory,
      board_context : context,
      cb,
    };

    inc_src.push(`${app_dir}/user_app.cpp`);
    setConfig(contextBoard);
	
	// console.log(inc_src);

    compileFiles(inc_src, [], cflags, cflags, inc_switch).then(() => {
      // Archiving built core (caching)
      // return archiveFiles(inc_src);
	}).then(() => {
      // Link
      return linkObject(ldflags, libflags);
    }).then(() => {
	  // Gen .bin
      return createBin();
    }).then(() => {
      resolve();
    }).catch(msg => {
      log("error msg : " + msg);
      reject(msg);
    });
  });
}
//=====================================//
const compileFiles = async function(sources, boardCppOptions, boardcflags, boardcppflags, plugins_includes_switch) {
  log('>>> Compile Files ...');
  const queue = new PQueue({ concurrency: 8 }); // run 8 on one time

  return new Promise(async (resolve, reject) => {
    let cflags = `${G.cflags.join(" ")} ${boardcflags.join(" ")}`;
	let cppflags = `${G.cppflags.join(" ")} ${boardcppflags.join(" ")}`;
	let Sflags = G.Sflags.join(" ");
    let inc_switch = plugins_includes_switch.map(obj => `-I"${obj}"`).join(" ");
    let debug_opt = "-DF_CPU=400000000L -DARDUINO=10810 -DK210 -DARCH=K210";

    let exec = async function(file, cmd) {
      try {
        log(`Compiling => ${file}`);
        const { stdout, stderr } = await execPromise(ospath(cmd), { cwd: G.process_dir });
        if (!stderr) {
          log(`Compiled ... ${file} OK.`);
          G.cb(`compiling... ${path.basename(file)} ok.`);
        } else {
          log(`Compiled... ${file} OK. (with warnings)`);
          G.cb(`compiling... ${path.basename(file)} ok. (with warnings)`);
        }
      } catch (e) {
        log(`Compile Error : ${e}`);
        console.error(`[maixdunio].compiler.js catch something`, e.error);
        console.error(`[maixdunio].compiler.js >>> `, e);
        reject({
          file: file,
          error: e
        });
      }
    };
	
	coreChange = false;
    
    // Compile File
    for (let file of sources) {
      let filename = getFileName(file);
      let fn_obj = `${G.app_dir}/${filename}.o`;
	  
	  // Check file before compile
	  let md5 = await md5File(file); // get md5 form source file
	  if (fs.existsSync(fn_obj)) { // if file .o have
	    if (typeof sourceFileMD5[encodeURIComponent(file)] !== "undefined") {
	      if (sourceFileMD5[encodeURIComponent(file)] === md5) { // if source file is old
            continue; // Skip
	      }
		}
	  }
	  sourceFileMD5[encodeURIComponent(file)] = md5;
	  
	  if (!file.endsWith("user_app.cpp")) {
        coreChange = true;
	  }
     
	  // .o file is old or don't have than compile
      let cmd = "";
      if (file.endsWith(".c")) { // .c
        cmd = `"${G.COMPILER_GCC}" ${cflags} ${inc_switch} ${debug_opt} "${file}" -o "${fn_obj}"`;
      } else if (file.endsWith(".cpp")) { // .cpp
        cmd = `"${G.COMPILER_CPP}" ${cppflags} ${inc_switch} ${debug_opt} "${file}" -o "${fn_obj}"`;
      } else if (file.endsWith(".S")) {
        cmd = `"${G.COMPILER_GCC}" ${Sflags} ${inc_switch} ${debug_opt} "${file}" -o "${fn_obj}"`;
	  }
      queue.add(async () => { await exec(file, cmd); });
    }
    await queue.onIdle();
    resolve();
  });
};

//=====================================//
const archiveFiles = async function(sources) {
  log('>>> Archiving built core ... <<<');

  for (let file of sources) {
	if (file.endsWith("user_app.cpp")) { // Skip main file
		continue;
	}
		
    let filename = getFileName(file);
    let fn_obj = `${G.app_dir}/${filename}.o`;
    let cmd = `"${G.COMPILER_AR}" rcs "${G.ARCHIVE_FILE}" "${fn_obj}"`;
	  
    log(`Archiving => ${file}`);
    const { stdout, stderr } = await execPromise(ospath(cmd), { cwd: G.process_dir });
	  
    if (!stderr) {
      log(`Archiving ... ${file} OK.`);
      G.cb(`Archiving... ${path.basename(file)} ok.`);
    } else {
      log(`Archiving... ${file} OK. (with warnings)`);
	  G.cb(`Archiving... ${path.basename(file)} ok. (with warnings)`);
    }
  }
};

function linkObject(boardldflags, extarnal_libflags) {
  log(`>>> Linking... ${G.ELF_FILE}`);
  G.cb(`linking... ${G.ELF_FILE}`);
  
  let ldflags = `${G.ldflags.join(" ")} ${boardldflags.join(" ")} ${extarnal_libflags.join(" ")}`;

  // let obj_files = fs.readdirSync(G.app_dir).filter(f => f.endsWith(".o"));
  // obj_files = obj_files.map(f => `"${G.app_dir}/${f}"`).join(" ");
  // obj_files = obj_files.map(f => `${G.app_dir}/${f}`);
  
  // cmd = `"${G.COMPILER_GCC}" ${ldflags} -T "${platformDir}/cores/kendryte-standalone-sdk/lds/kendryte.ld" ${G.app_dir}/user_app.cpp.o -o "${G.ELF_FILE}" -Wl,--start-group -lgcc -lm -lc -Wl,--end-group -Wl,--start-group "${G.ARCHIVE_FILE}" -lgcc -lm -lc -Wl,--end-group`;
  // cmd = `"${G.COMPILER_GCC}" ${ldflags} -T "${platformDir}/cores/kendryte-standalone-sdk/lds/kendryte.ld" ${obj_files} -o "${G.ELF_FILE}" -Wl,--start-group -lgcc -lm -lc -Wl,--end-group -Wl,--start-group "${G.ARCHIVE_FILE}" -lgcc -lm -lc -Wl,--end-group`;
  // return execPromise(ospath(cmd), { cwd: G.process_dir });
  
  let arg = [];
  arg = arg.concat(ldflags.split(' '));
  arg.push("-T");
  arg.push(`${platformDir}/cores/kendryte-standalone-sdk/lds/kendryte.ld`);
  arg = arg.concat(engine.util.walk(G.app_dir).filter(f => path.extname(f) === ".o"));
  arg = arg.concat(engine.util.walk(`${boardDirectory}/lib`).filter(f => path.extname(f) === ".o"));
  arg.push('-o');
  arg.push(G.ELF_FILE);
  arg = arg.concat("-Wl,--gc-sections -Wl,-static -Wl,--whole-archive -Wl,--no-whole-archive -Wl,-EL -Wl,--no-relax -Wl,--start-group".split(' '));
  arg = arg.concat(`${G.ldlibflag.join(" ")} ${extarnal_libflags.join(" ")}`.split(' '));
  arg = arg.concat(engine.util.walk(`${platformDir}/lib`).filter(f => path.extname(f) === ".a"));
  arg = arg.concat(engine.util.walk(`${boardDirectory}/lib`).filter(f => path.extname(f) === ".a"));
  arg = arg.concat("-lgcc -lm -lc -Wl,--end-group".split(' '));
  
  arg = arg.map(p => ospath(p)).filter(x => x.length > 0);
  
  // console.log(ospath(G.COMPILER_CPP), arg.join(' '));
  
  return new Promise((resolve, reject) => {
    execFile(ospath(G.COMPILER_CPP), arg, {cwd: G.process_dir }, (error, stdout, stderr) => {
      if (error) {
        console.warn(error);
		reject(error);
		return;
      }
      resolve(stdout ? stdout : stderr);
    });
  });
}

function archiveProgram(plugins_sources) {
  log(`>>> Archiving... ${G.ARCHIVE_FILE}`);
  
  let obj_files = plugins_sources.map(plugin => `"${G.app_dir}/${getName(plugin)}.o"`).join(" ");
  
  var cmd = `"${G.COMPILER_AR}" rcs "${G.ARCHIVE_FILE}" ${obj_files}`;
  return execPromise(ospath(cmd), { cwd: G.process_dir });
}

function createBin() {
  log(`Creating bin image... ${G.BIN_FILE}`);

  let cmd_hex = `"${G.COMPILER_OBJCOPY}" --output-format=binary "${G.ELF_FILE}" "${G.BIN_FILE}"`;
  return execPromise(ospath(cmd_hex), { cwd: G.process_dir });
}

function flash(port, baudrate, stdio) {
  log(`Flashing ... ${G.BIN_FILE}`);
  
  baudrate = G.board_context.baudrate || baudrate || 2000000;
  stdio = stdio || "inherit";
  let cmd = `"${G.COMPILER_KFLASH}" -n -p ${port} -b ${baudrate} -B dan "${G.BIN_FILE}"`;
  return execPromise(ospath(cmd), { cwd: G.process_dir, stdio });
}

module.exports = {
  compile,
  setConfig,
  linkObject,
  compileFiles,
  archiveProgram,
  createBin,
  flash
};
