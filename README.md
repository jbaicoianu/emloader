Emscripten Loader

Easily embed Emscripten-compiled apps in any webpage.  Manages prefetching, filesystem mounts, and system setup and management.

Usage
-----
{{{
      var dos = new EMLoader({
        executable: '/scripts/systems/dosbox.js',
        executableargs: [
          '-c', 'mount c /mnt/drivec'
          '-c', 'mount d /mnt/drived'
          '/mnt/drivec/DOS/DOSSHELL.EXE',
        ],
        exportname: 'DOSBOX',
        canvas: document.createElement('canvas'),

        mnt: {
          '/drivec/': ['zip', '/diskimages/dos.zip'],
          '/drived/games': ['zip', '/diskimages/games.zip'],
          '/drived/apps': ['zip', '/diskimages/apps.zip'],
        }
      });

}}}
