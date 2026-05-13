'use strict';
var fs = require('fs');
var path = require('path');

module.exports = function(config) {
    var dir = process.env.HISTORY_DIR;
    var preserveLastNTicks = parseInt(process.env.HISTORY_PRESERVE_TICKS || '0', 10);
    if (!dir || !config.engine) return;
    config.engine.on('saveRoomHistory', function(roomName, baseTime, data) {
        var roomDir = path.resolve(dir, roomName);
        if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });
        fs.writeFileSync(path.resolve(roomDir, baseTime + '.json'), JSON.stringify(data));
        if (preserveLastNTicks > 0) {
            var chunkSize = Object.keys(data.ticks).length || 20;
            var keepChunks = Math.ceil(preserveLastNTicks / chunkSize);
            var files = fs.readdirSync(roomDir)
                .filter(function(f) { return /^\d+\.json$/.test(f); })
                .map(function(f) { return parseInt(f, 10); })
                .sort(function(a, b) { return b - a; });
            files.slice(keepChunks).forEach(function(t) {
                try { fs.unlinkSync(path.resolve(roomDir, t + '.json')); } catch (_) {}
            });
        }
    });
};
