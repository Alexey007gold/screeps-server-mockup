import * as _ from 'lodash';
import * as util from 'util';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import TerrainMatrix from './terrainMatrix';
import User, { UserBadge } from './user';
import ScreepsServer from './screepsServer';

export interface RoomSnapshot {
    mainRoom: string;
    gameTime: number;
    rooms: Record<string, { terrain: string; objects: any[] }>;
    users: any[];
    options: Record<string, any>;
    memories?: Record<string, Record<string, any>>;
}

interface AddBotOptions {
    username: string;
    room: string;
    x: number;
    y: number;
    gcl?: number;
    cpu?: number;
    cpuAvailable?: number;
    active?: number;
    spawnName?: string;
    modules?: {};
    guiBot?: boolean;
    badge?: object | null;
}

// Terrain string for room completely filled with walls
const walled = '1'.repeat(2500);

export default class World {
    private server: ScreepsServer;
    /**
        Constructor
    */
    constructor(server: ScreepsServer) {
        this.server = server;
    }

    /**
        Getters
    */
    get gameTime(): Promise<number> {
        return this.load().then(({ env }) => env.get(env.keys.GAMETIME));
    }

    /**
        Connect to server (if needed) and return constants, database, env and pubsub objects
    */
    async load() {
        if (!this.server.connected) await this.server.connect();
        const { db, env, pubsub } = this.server.common.storage;
        const C = this.server.constants;
        return { C, db, env, pubsub };
    }

    /**
        Set room status (and create it if needed)
        This function does NOT generate terrain data
    */
    async setRoom(room: string, status = 'normal', active = true) {
        const { db } = this.server.common.storage;
        const data = await db.rooms.find({ _id: room });
        if (data.length > 0) {
            await db.rooms.update({ _id: room }, { $set: { status, active } });
        } else {
            await db.rooms.insert({ _id: room, status, active });
        }
        await this.server.driver.updateAccessibleRoomsList();
    }

    /**
        Simplified alias for setRoom()
    */
    async addRoom(room: string) {
        return this.setRoom(room);
    }

    /**
        Return room terrain data (walls, plains and swamps)
        Return a TerrainMatrix instance
    */
    async getTerrain(room: string) {
        const { db } = this.server.common.storage;
        // Load data
        const data = await db['rooms.terrain'].find({ room });
        // Check if data actually exists
        if (data.length === 0) {
            throw new Error(`room ${room} doesn't appear to have any terrain data`);
        }
        // Parse and return terrain data as a TerrainMatrix
        const serial = _.get(_.first(data), 'terrain');
        return TerrainMatrix.unserialize(serial);
    }

    /**
        Define room terrain data (walls, plains and swamps)
        @terrain must be an instance of TerrainMatrix.
    */
    async setTerrain(room: string, terrain = new TerrainMatrix()) {
        const { db, env } = this.server.common.storage;
        // Check parameters
        if (!(terrain instanceof TerrainMatrix)) {
            throw new Error('@terrain must be an instance of TerrainMatrix');
        }
        // Insert or update data in database
        const data = await db['rooms.terrain'].find({ room });
        if (data.length > 0) {
            await db['rooms.terrain'].update({ room }, { $set: { terrain: terrain.serialize() } });
        } else {
            await db['rooms.terrain'].insert({ room, terrain: terrain.serialize() });
        }
        // Update environment cache
        await this.updateEnvTerrain(db, env);
    }

    /**
        Add a RoomObject to the specified room
        Returns db operation result
    */
    async addRoomObject(room: string, type: string, x: number, y: number, attributes: {} = {}) {
        const { db } = this.server.common.storage;
        // Check parameters
        if (x < 0 || y < 0 || x >= 50 || y >= 50) {
            throw new Error('invalid x/y coordinates (they must be between 0 and 49)');
        }
        // Inject data into database
        const object = { ...{ room, x, y, type }, ...attributes };
        return db['rooms.objects'].insert(object);
    }

    /**
        Reset world data to a barren world with no rooms, but with invaders and source keepers users
    */
    async reset() {
        const { db, env } = await this.load();
        // Clear database
        await Promise.all(_.map(db, (col) => col.clear()));
        await env.set(env.keys.GAMETIME, 1);

        // Insert invaders and sourcekeeper users
        await Promise.all([
            db.users.insert({ _id: '2', username: 'Invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }),
            db.users.insert({ _id: '3', username: 'Source Keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 })
        ]);
    }

    /**
        Stub a basic world by adding 9 plausible rooms with sources, minerals and controllers
    */
    async stubWorld() {
        // Clear database
        await this.reset();
        // Utility functions
        const addRoomObjects = (roomName: string, objects: Array<any>) => Promise.all(
            objects.map((o) => this.addRoomObject(roomName, o.type, o.x, o.y, o.attributes))
        );
        const addRoom = (roomName: string, terrain: any, roomObjects: Array<any>) => Promise.all([
            this.addRoom(roomName),
            this.setTerrain(roomName, terrain),
            addRoomObjects(roomName, roomObjects)
        ]);
        // Add rooms
        // eslint-disable-next-line global-require, import/no-unresolved
        const rooms = require('../../assets/rooms.json');
        await Promise.all(_.map(rooms, (data, roomName) => {
            const terrain = TerrainMatrix.unserialize(data.serial);
            return addRoom(roomName, terrain, data.objects);
        }));
    }

    /**
        Get the roomObjects list for requested roomName
    */
    async roomObjects(roomName: string): Promise<any[]> {
        const { db } = await this.load();
        return db['rooms.objects'].find({ room: roomName });
    }

    /**
        Generate a random badge for a user.
        Taken from https://github.com/screeps/backend-local/blob/master/lib/cli/bots.js#L37.
     */
    genRandomBadge(): UserBadge {
        const badge: UserBadge = {
            type : Math.floor(Math.random() * 24) + 1,
            color1 : `#${Math.floor(Math.random() * 0xffffff).toString(16)}`,
            color2 : `#${Math.floor(Math.random() * 0xffffff).toString(16)}`,
            color3 : `#${Math.floor(Math.random() * 0xffffff).toString(16)}`,
            flip : Math.random() > 0.5,
            param : Math.floor(Math.random() * 200) - 100,
        };
        return badge;
    }

    /**
        Add a new user to the world
    */
    async addBot({ username, room, x, y, gcl = 1, cpu = 100, cpuAvailable = 10000, active = 10000, spawnName = 'Spawn1', modules = {}, guiBot = false, badge = null }: AddBotOptions) {
        const { C, db, env } = await this.load();
        // Ensure that there is a controller in requested room
        const data = await db['rooms.objects'].findOne({ $and: [{ room }, { type: 'controller' }] });
        if (data == null) {
            throw new Error(`cannot add user in ${room}: room does not have any controller`);
        }
        // Insert user and update data
        const user = await db.users.insert(
            { username, cpu, cpuAvailable, gcl, active, badge: this.genRandomBadge() }
        );
        await Promise.all([
            env.set(env.keys.MEMORY + user._id, '{}'),
            env.sadd(env.keys.ACTIVE_ROOMS, room),
            db.rooms.update({ _id: room }, { $set: { active: true } }),
            db['users.code'].insert({ user: user._id, branch: 'default', modules, activeWorld: true }),
            db['rooms.objects'].update({ room, type: 'controller' }, { $set: { user: user._id, level: 1, progress: 0, downgradeTime: null, safeMode: 20000 } }),
            db['rooms.objects'].insert({ room, type: 'spawn', x, y, user: user._id, name: spawnName, store : { energy: C.SPAWN_ENERGY_START }, storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY }, hits: C.SPAWN_HITS, hitsMax: C.SPAWN_HITS, spawning: null, notifyWhenAttacked: true }),
        ]);
        if (guiBot) this.server._registerGuiBot(username, badge);
        // Subscribe to console notification and return emitter
        return new User(this.server, user).init();
    }

    /**
        Generate map PNG assets for all rooms with terrain data:
          map/<room>.png        — 150×150 (3px/cell) used by the old world overview
          map/zoom2/<tile>.png  — 200×200 merged 4×4-room tile used by new map visuals
        Both are served by the backend at /assets/map/...
    */
    async generateMapImages() {
        const { db } = this.server.common.storage;
        const mapDir = path.resolve(this.server.opts.path, 'map');
        const zoom2Dir = path.resolve(mapDir, 'zoom2');
        if (!fs.existsSync(mapDir))  fs.mkdirSync(mapDir,  { recursive: true });
        if (!fs.existsSync(zoom2Dir)) fs.mkdirSync(zoom2Dir, { recursive: true });

        const WALL = 1, SWAMP = 2;

        function roomToXY(name: string): [number, number] {
            const m = name.match(/^([WE])(\d+)([NS])(\d+)$/);
            if (!m) throw new Error(`invalid room name: ${name}`);
            const [, hor, xs, ver, ys] = m;
            return [hor === 'W' ? -Number(xs) - 1 : Number(xs),
                    ver === 'N' ? -Number(ys) - 1 : Number(ys)];
        }

        function xyToRoom(x: number, y: number): string {
            return `${x < 0 ? 'W' + (-x - 1) : 'E' + x}${y < 0 ? 'N' + (-y - 1) : 'S' + y}`;
        }

        function renderRoom(serial: string, cellSize: number): Buffer {
            const W = 50 * cellSize;
            const buf = Buffer.alloc(W * W * 4);
            for (let cy = 0; cy < 50; cy++) {
                for (let cx = 0; cx < 50; cx++) {
                    const mask = parseInt(serial[cy * 50 + cx], 10);
                    let r, g, b;
                    if (mask & WALL)       { r = 0;  g = 0;  b = 0;  }
                    else if (mask & SWAMP) { r = 35; g = 37; b = 19; }
                    else if (cx === 0 || cy === 0 || cx === 49 || cy === 49) { r = 50; g = 50; b = 50; }
                    else                   { r = 43; g = 43; b = 43; }
                    for (let dy = 0; dy < cellSize; dy++) {
                        for (let dx = 0; dx < cellSize; dx++) {
                            const idx = ((cy * cellSize + dy) * W + (cx * cellSize + dx)) << 2;
                            buf[idx] = r; buf[idx + 1] = g; buf[idx + 2] = b; buf[idx + 3] = 255;
                        }
                    }
                }
            }
            return buf;
        }

        function writePng(data: Buffer, size: number, filePath: string): Promise<void> {
            return new Promise((resolve, reject) => {
                const png = new PNG({ width: size, height: size });
                png.data = data;
                png.pack().pipe(fs.createWriteStream(filePath))
                    .on('finish', resolve).on('error', reject);
            });
        }

        const terrainDocs: Array<{ room: string; terrain: string }> = await db['rooms.terrain'].find();
        const byRoom = new Map(terrainDocs.map((d: { room: string; terrain: string }) => [d.room, d.terrain]));

        // 1. Per-room 150×150 thumbnails
        const roomPngs = terrainDocs.map(({ room, terrain }: { room: string; terrain: string }) =>
            writePng(renderRoom(terrain, 3), 150, path.resolve(mapDir, `${room}.png`))
        );

        // 2. Zoom2 4×4 merged tiles (200×200, 1px/cell per room)
        const tiles = new Map<string, { tx: number; ty: number; rooms: Array<{ room: string; x: number; y: number }> }>();
        for (const room of byRoom.keys()) {
            const [x, y] = roomToXY(room);
            const tx = Math.floor(x / 4) * 4;
            const ty = Math.floor(y / 4) * 4;
            const key = `${tx},${ty}`;
            if (!tiles.has(key)) tiles.set(key, { tx, ty, rooms: [] });
            tiles.get(key)!.rooms.push({ room, x, y });
        }

        const zoom2Pngs = [...tiles.values()].map(({ tx, ty, rooms: tileRooms }) => {
            const buf = Buffer.alloc(200 * 200 * 4);
            for (const { room, x, y } of tileRooms) {
                const serial = byRoom.get(room)!;
                const ox = (x - tx) * 50, oy = (y - ty) * 50;
                const src = renderRoom(serial, 1);
                for (let py = 0; py < 50; py++) {
                    for (let px = 0; px < 50; px++) {
                        const si = (py * 50 + px) << 2;
                        const di = ((oy + py) * 200 + (ox + px)) << 2;
                        buf[di] = src[si]; buf[di+1] = src[si+1];
                        buf[di+2] = src[si+2]; buf[di+3] = src[si+3];
                    }
                }
            }
            return writePng(buf, 200, path.resolve(zoom2Dir, `${xyToRoom(tx, ty)}.png`));
        });

        await Promise.all([...roomPngs, ...zoom2Pngs]);
    }

    async captureSnapshot(mainRoom: string, options: Record<string, any> = {}): Promise<RoomSnapshot> {
        const { db, env } = await this.load();
        const gameTime = await env.get(env.keys.GAMETIME);
        const allRoomDocs = await db.rooms.find();

        const rooms: Record<string, { terrain: string; objects: any[] }> = {};
        for (const roomDoc of allRoomDocs) {
            const rName = roomDoc._id;
            let rObjects: any[] = [];
            try { rObjects = await this.roomObjects(rName); } catch (_) {}
            rooms[rName] = { terrain: (await this.getTerrain(rName)).serialize(), objects: rObjects };
        }

        const allUserDocs = await db.users.find();
        const botUsers = allUserDocs.filter((u: any) => !['1', '2', '3'].includes(u._id));
        const guiBadges: Record<string, object> = (this.server as any)._guiBotBadges || {};
        const users = botUsers.map(({ $loki: _l, meta: _m, ...u }: any) => {
            const badge = u.badge ?? guiBadges[u.username] ?? null;
            return badge ? { ...u, badge } : u;
        });

        const memories: Record<string, Record<string, any>> = {};
        for (const u of botUsers) {
            try {
                const raw = await env.get(env.keys.MEMORY + u._id);
                if (raw) memories[u.username] = JSON.parse(raw);
            } catch (_) {}
        }

        return { mainRoom, gameTime, rooms, users, options, memories };
    }

    async restoreSnapshot(snapshot: RoomSnapshot, modules: Record<string, string>, botName: string): Promise<User[]> {
        const { mainRoom, rooms: allRooms, gameTime, memories: savedMemories } = snapshot;

        await this.reset();

        for (const [roomName, roomData] of Object.entries(allRooms)) {
            await this.addRoom(roomName);
            await this.setTerrain(roomName, TerrainMatrix.unserialize(roomData.terrain));
        }

        const { db, env } = await this.load();

        await env.set(env.keys.GAMETIME, gameTime);
        await db.rooms.update({ _id: mainRoom }, { $set: { active: true } });

        const bots: User[] = [];
        for (const userRec of snapshot.users) {
            const { $loki: _l, meta: _m, ...attrs } = userRec;
            await db.users.insert(attrs);

            let user = new User(this.server, attrs);
            await user.setMemory(JSON.stringify(savedMemories?.[attrs.username] ?? {}));

            if (attrs.username !== botName) continue;

            await db['users.code'].insert({ user: attrs._id, branch: 'default', modules, activeWorld: true });
            this.server._registerGuiBot(attrs.username, attrs.badge ?? null);
            await user.init();
            bots.push(user);
        }

        for (const roomData of Object.values(allRooms)) {
            for (const obj of roomData.objects) {
                const { $loki: _l, meta: _m, ...attrs } = obj;
                await db['rooms.objects'].insert(attrs);
            }
        }

        return bots;
    }

    private async updateEnvTerrain(db: any, env: any) {
        const [rooms, terrain] = await Promise.all([
            db.rooms.find(),
            db['rooms.terrain'].find()
        ]);
        rooms.forEach((room: any) => {
            if (room.status === 'out of borders') {
                _.find(terrain, { room: room._id }).terrain = walled;
            }
            const m = room._id.match(/(W|E)(\d+)(N|S)(\d+)/);
            const roomH = m[1] + (+m[2] + 1) + m[3] + m[4];
            const roomV = m[1] + m[2] + m[3] + (+m[4] + 1);
            if (!_.some(terrain, { room: roomH })) {
                terrain.push({ room: roomH, terrain: walled });
            }
            if (!_.some(terrain, { room: roomV })) {
                terrain.push({ room: roomV, terrain: walled });
            }
        });
        const compressed = await util.promisify(zlib.deflate)(JSON.stringify(terrain));
        await env.set(env.keys.TERRAIN_DATA, (compressed as any).toString('base64'));
    }
}
