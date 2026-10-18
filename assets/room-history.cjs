'use strict';
var fs = require('fs');
var path = require('path');

module.exports = function(config) {
    var dir = process.env.HISTORY_DIR;
    var preserveLastNTicks = parseInt(process.env.HISTORY_PRESERVE_TICKS || '0', 10);
    if (!dir || !config.engine) return;

    var driver = require.main.require(process.env.DRIVER_MODULE);
    var getDiff = require.main.require('@screeps/common').getDiff;
    var chunkSize = driver.config.historyChunkSize;
    var buffers = {};
    var flushedBelow = 0;

    function writeChunk(roomName, baseTime, data) {
        var roomDir = path.resolve(dir, roomName);
        if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });
        fs.writeFileSync(path.resolve(roomDir, baseTime + '.json'), JSON.stringify(data));
        if (preserveLastNTicks > 0) {
            var keepChunks = Math.ceil(preserveLastNTicks / chunkSize);
            var files = fs.readdirSync(roomDir)
                .filter(function(f) { return /^\d+\.json$/.test(f); })
                .map(function(f) { return parseInt(f, 10); })
                .sort(function(a, b) { return b - a; });
            files.slice(keepChunks).forEach(function(t) {
                try { fs.unlinkSync(path.resolve(roomDir, t + '.json')); } catch (_) {}
            });
        }
    }

    function flush(roomName) {
        var buffer = buffers[roomName];
        delete buffers[roomName];
        var times = Object.keys(buffer.ticks).map(Number).sort(function(a, b) { return a - b; });
        var prev = JSON.parse(buffer.ticks[times[0]]);
        var result = { timestamp: Date.now(), room: roomName, base: buffer.base, ticks: {} };
        result.ticks[times[0]] = prev;
        for (var i = 1; i < times.length; i++) {
            var objects = JSON.parse(buffer.ticks[times[i]]);
            result.ticks[times[i]] = getDiff(prev, objects);
            prev = objects;
        }
        writeChunk(roomName, buffer.base, result);
    }

    driver.history.upload = function() {
        return Promise.resolve();
    };

    driver.history.saveTick = function(roomId, gameTime, data) {
        var base = gameTime - gameTime % chunkSize;
        if (base > flushedBelow) {
            Object.keys(buffers)
                .filter(function(roomName) { return buffers[roomName].base < base; })
                .forEach(flush);
            flushedBelow = base;
        }
        if (!buffers[roomId]) buffers[roomId] = { base: base, ticks: {} };
        buffers[roomId].ticks[gameTime] = data;
        return Promise.resolve();
    };

    process.once('SIGTERM', function() {
        Object.keys(buffers).forEach(flush);
        process.kill(process.pid, 'SIGTERM');
    });
};
