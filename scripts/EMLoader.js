/** 
 * EMLoader - a generalized wrapper for loading emscripten-compiled content
 *
 * @class EMLoader
 * @param {object}   args
 * @param {string}   executable
 * @param {array}    executableargs
 * @param {boolean} [args.useWorker=false]
 * @param {boolean} [args.useSound=true]
 * @param {boolean} [args.useWebGL=false]
 * @param {string}   modulepath
 * @param {object}   mnt
 *
 * @example
 *  var loader = new EMLoader({
 *    'executable': '/media/emscripten/dosbox.js',
 *    'executableargs': ['-c' 'mount a /drivea', '-c', 'mount c /drivec', '-c', 'mount d /drived', 'STARTUP.BAT'],
 *    'mnt': {
 *      '/dosbox.conf' : ['file', '/media/configs/dosbox-custom01.conf'  ],
 *      '/drivea'      : ['localstorage'],
 *      '/drivec'      : ['zip', '/media/disks/windows.zip'],
 *      '/drivec/apps' : ['zip', '/media/disks/apps.zip'   ],
 *      '/drivec/games': ['zip', '/media/disks/games.zip'  ],
 *      '/drived'      : ['dropbox', ... ],
 *    }
 *  });
 */
function EMLoader(args) {
  // Process arguments
  if (!args) args = {};
  this.webroot   = (args.webroot !== undefined ? args.webroot : '');
  this.useWorker = (args.useWorker !== undefined ? args.useWorker : false);
  this.useWebGL  = (args.useWebGL !== undefined ? args.useWebGL : false);
  this.useSound  = (args.useSound !== undefined ? args.useSound : true);
  this.executable  = (args.executable !== undefined ? args.executable : false);
  this.executableargs  = (args.executableargs !== undefined ? args.executableargs : []);
  this.exportname  = (args.exportname !== undefined ? args.exportname : false);
  this.canvas  = (args.canvas !== undefined ? args.canvas : false);
  this.modulepath = args.modulepath || ('/' + this.generateRandomID());
  this.initialized = false;

  this.pendingfiles = 0;
  this.module = {};

  // Detect capabilities
  this._runningInWorker = (typeof window == 'undefined' || (typeof ENVIRONMENT_IS_WORKER != 'undefined' && ENVIRONMENT_IS_WORKER));
  this._usingWorker = (this.useWorker && (typeof Worker != 'undefined' || this._runningInWorker));
  this._usingWebGL = (this.useWebGL && typeof WebGLRenderingContext != 'undefined');
  this._usingSound = (this.useSound && typeof AudioContext != 'undefined');

  console.log('System capabilities (' + (this._runningInWorker ? 'worker' : 'main') + ' thread): [' + 
      (this._usingWebGL ? 'x' : ' ') + '] WebGL\t[' +
      (this._usingSound ? 'x' : ' ') + '] Sound\t[' +
      (this._usingWorker ? 'x' : ' ') + '] WebWorker');

  if (args.mnt) {
    this.init_filesystem(args.mnt);
  } else {
    this.init_script();
  }
}

EMLoader.prototype = Object.create(EventDispatcher.prototype);
EMLoader.prototype.constructor = EMLoader;

EMLoader.prototype.get_globalfs = function() {
  var globalfs = EMLoader.globalfs;
  if (!globalfs) {
    globalfs = EMLoader.globalfs = new BrowserFS.FileSystem.MountableFileSystem();
    BrowserFS.initialize(globalfs);
  }
  return globalfs;
}

/**
 * Initialize BrowserFS filesystem, and starts asynchronous loads
 * @function init_filesystem
 * @memberof EMLoader
 * @param {object} mnt
 */
EMLoader.prototype.init_filesystem = function(mntmap) {
  var globalfs = this.get_globalfs();

  this.modulefs = new BrowserFS.FileSystem.MountableFileSystem();
  globalfs.mount(this.modulepath, this.modulefs);

  for (var path in mntmap) {
    var type = mntmap[path][0],
        url = mntmap[path][1];
    if (url) {
      this.add_file(url, this.set_file.bind(this, path, type));
    } else {
      this.set_file(path, type);
    }
  }
}
/**
 * Completes filesystem initialization by mounting under emscripten
 * @function finalize_filesystem
 * @memberof EMLoader
 */
EMLoader.prototype.finalize_filesystem = function() {
  var globalfs = this.get_globalfs();
  BrowserFS.initialize(globalfs);

  this.emscriptenfs = new BrowserFS.EmscriptenFS(this.module.FS, this.module.PATH, this.module.ERRNO_CODES);
  this.module.FS.mkdir('/mnt');
  this.module.FS.mount(this.emscriptenfs, {root: '/'}, '/mnt');
  this.module.FS.chdir('/mnt' + this.modulepath);
}
/**
 * Prints out the contents of the filesystem
 * @function dumpFS
 * @memberof EMLoader
 * @param {string} dir
 * @param {BrowserFS.FileSystem} [vfs]
 */
EMLoader.prototype.dumpFS = function(dir, vfs) {
  var fs = vfs || BrowserFS.BFSRequire('fs');
  if (!dir) {
    dir = '/';
  }

  var depth = dir.split('/').length;
  var prefix = new Array(depth).join('\t');

  //fs.readdirSync(dir, function(err, files) {
  var files = fs.readdirSync(dir);
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var stat = fs.statSync(dir + file)
      if (stat && stat.isDirectory()) {
        console.log(prefix + file + '/');
        this.dumpFS(dir + file + '/', fs);
      } else {
        console.log(prefix + file);
      }
    }
  //}.bind(this));
}
/**
 * Sets the contents for the specified path, based on type
 * @function set_file
 * @memberof EMLoader
 * @param {string} path
 * @param {string} type
 * @param {*} data
 */
EMLoader.prototype.set_file = function(path, type, data) {
  console.log('the file is done', path, type);

  // strip trailing slash if present
  if (path[path.length - 1] == '/') 
    path = path.substr(0, path.length-1);

  switch (type) {
    case 'zip':
      this.set_file_zip(path, data);
      break;
    case 'file':
      this.set_file_contents(path, data);
      break;
    case 'localstorage':
      this.set_file_localstorage(path, data);
      break;
  }
}
/**
 * Mount a zip at the specified location
 * @function set_file_zip
 * @memberof EMLoader
 * @param {string} path
 * @param {*} data
 */
EMLoader.prototype.set_file_zip = function(path, data) {
  var ldata = new BrowserFS.BFSRequire('buffer').Buffer(data);
  var zipfs = new BrowserFS.FileSystem.ZipFS(ldata);
  var globalfs = this.get_globalfs();
  var modulefs = this.modulefs;
  var memfs = new BrowserFS.FileSystem.InMemory();
  var fullpath = '/mem';

  modulefs.mount('/zip', zipfs);
  modulefs.mount('/mem', memfs);
  this.recursive_copy('/zip', fullpath);
  modulefs.umount('/zip');
  modulefs.umount('/mem');

  modulefs.mount(path, memfs);
}
/**
 * Set the specified file's contents
 * @function set_file_contents
 * @memberof EMLoader
 * @param {string} path
 * @param {*} data
 */
EMLoader.prototype.set_file_contents = function(path, data) {
  var ldata = new BrowserFS.BFSRequire('buffer').Buffer(data);
  var fs = BrowserFS.BFSRequire('fs');
  var fullpath = this.modulepath + path;

  fs.writeFile(fullpath, ldata);
}
/**
 * Mounts a localstorage filesystem at the specified path
 * @function set_file_localstorage
 * @memberof EMLoader
 * @param {string} path
 */
EMLoader.prototype.set_file_localstorage = function(path) {
  var localfs = new BrowserFS.FileSystem.LocalStorage();
  this.modulefs.mount(path, localfs);
}
/**
 * Copies the contents of a directory from one location to another
 * @function recursive_copy
 * @memberof EMLoader
 * @param {string} oldDir
 * @param {string} newDir
 */
EMLoader.prototype.recursive_copy = function(oldDir, newDir) {
  var path = BrowserFS.BFSRequire('path'),
      fs = BrowserFS.BFSRequire('fs');

  // FIXME - it's a bit of a pain that we have to go through the global nodefs object 
  //         since BrowserFS makes it hard to work with individual filesystems directly

  copyDirectory(this.modulepath + oldDir, this.modulepath + newDir);

  function copyDirectory(oldDir, newDir) {
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir);
    }
    fs.readdirSync(oldDir).forEach(function(item) {
      var p = path.resolve(oldDir, item),
          newP = path.resolve(newDir, item);
      if (fs.statSync(p).isDirectory()) {
        copyDirectory(p, newP);
      } else {
        copyFile(p, newP);
      }
    });
  }
  function copyFile(oldFile, newFile) {
    //console.log('copy: ' + oldFile + ' => ' + newFile);
    fs.writeFileSync(newFile, fs.readFileSync(oldFile));
  }
};
/**
 * Update the load progress indicator
 * @function load_progress
 * @memberof EMLoader
 * @param {Event} ev
 */
EMLoader.prototype.load_progress = function(ev) {
  console.log("progress", ev);
}
/**
 * Load module script file
 * @function init_script
 * @memberof EMLoader
 */
EMLoader.prototype.init_script = function() {
  var script = document.createElement('script');
  script.src = this.executable;
  var head = document.getElementsByTagName('head')[0];
  head.appendChild(script);

  if (this.exportname) {
    script.addEventListener('load', this.init_module.bind(this));
  } else {
    this.init_module();
  }
}
/**
 * Initialize Emscripten module
 * @function init_module
 * @memberof EMLoader
 */
EMLoader.prototype.init_module = function() {
  //Module = this.module = {};

  var input = document.createElement('input');
  input.style.cssText = 'position: absolute; width: 0; height: 0; border: 0;';

  var module = {};
  module.noInitialRun = false;
  module.screenIsReadOnly = true;
  module.arguments = this.executableargs;

  console.log('ARGS', module.arguments);

  module.canvas = this.init_canvas(this.canvas);
  module.keyboardListeningElement = this.canvas;
  module.memoryInitializerPrefixURL = '/media/vrcade/games/win311/';
  module.printErr = function(m) { console.error(m); };
  module.preRun = [ 
    this.init_environment.bind(this),
    this.finalize_filesystem.bind(this) 
  ];

  module.canvas.addEventListener('click', this.handleClick.bind(this));
  //module.canvas.parentNode.appendChild(module.keyboardListeningElement);

  this.module = module;
  if (this.exportname && typeof window[this.exportname] == 'function') {
    this.module = window[this.exportname](module);
  } else {
    this.module = window.Module = module;
  }
}
/**
 * Initialize canvas, creating if necessary
 * @function init_canvas
 * @memberof EMLoader
 */
EMLoader.prototype.init_canvas = function(canvas) {
  var canvas = canvas || document.createElement('canvas');
  canvas.tabIndex = (EMLoader.lastTabIndex || 0) + 1;
  EMLoader.lastTabIndex = canvas.tabIndex;
  if (!canvas.parentNode) {
    document.body.appendChild(canvas);
  }
  return canvas;
}
EMLoader.prototype.init_environment = function() {
  var ENV = this.module.ENV || window.ENV || false;
  if (ENV) {
    ENV["SDL_EMSCRIPTEN_KEYBOARD_ELEMENT"] = "#canvas";
  }
}
EMLoader.prototype.handleClick = function(ev) {
  if (document.activeElement !== this.canvas && !document.pointerLockElement) {
    this.canvas.focus(); 
    this.canvas.requestPointerLock();
  }
}

EMLoader.prototype.generateRandomID = function() {
  // From http://stackoverflow.com/questions/105034/how-to-create-a-guid-uuid-in-javascript
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

EMLoader.prototype.add_file = function(url, callback) {
  console.log('add it', url);
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.responseType = 'arraybuffer';
  xhr.onload = this.file_complete.bind(this, url, callback);
  xhr.onprogress = this.file_progress.bind(this, url);

  if (this.pendingfiles == 0) {
    this.dispatchEvent({type: 'batch_begin'});
  }
  this.pendingfiles++;
  this.dispatchEvent({type: 'file_begin', data: { url: url }});
  xhr.send();
}
EMLoader.prototype.file_progress = function(url, ev) {
  this.dispatchEvent({type: 'file_progress', data: ev});
  console.log(url, ev);
}
EMLoader.prototype.file_complete = function(url, callback, ev) {
  console.log('blurp', ev, this);
  var xhr = ev.target;

  if (xhr.status != 200) return;
  var data = new Int8Array(xhr.response);
  callback(data);

  this.dispatchEvent({type: 'file_complete'});
  if (--this.pendingfiles == 0) {
    this.batch_complete();
  }
}
EMLoader.prototype.batch_complete = function() {
  this.dispatchEvent({type: 'batch_complete'});
  this.init_script();
}

/**
 * DOSBoxLoader - convenience class for running DOSBox emulated systems
 * @class JSMESSLoader
 */

function DOSBoxLoader(args) {
  
}
DOSBoxLoader.prototype = Object.create(EMLoader.prototype);

/**
 * JSMESSLoader - convenience class for running JSMESS emulated systems
 * @class JSMESSLoader
 */
function JSMESSLoader(args) {
  var romfile = args.romfile,
      filename = '/' + romfile.split('/').pop(),
      gamename = filename.substr(1).replace('.zip', '');
  args.mnt = {};
  args.mnt[filename] = ['file', args.romfile];
  args.modulepath = ('/' + this.generateRandomID());

  var rompath = '/mnt' + args.modulepath;
  args.executableargs = [gamename, "-rompath",rompath,"-window","-resolution","292x240","-nokeepaspect","-autoframeskip","-sound","js"];
  EMLoader.call(this, args);
}
JSMESSLoader.prototype = Object.create(EMLoader.prototype);
