/* eslint no-console: "off" */

import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs-extra-promise';
import * as _ from 'lodash';
import * as path from 'path';
import World from './world';

const common = require('@screeps/common');
const driver = require('@screeps/driver');

const ASSETS_PATH = path.join(__dirname, '..', '..', 'assets');
const MOD_FILE = 'mods.json';
const DB_FILE = 'db.json';
const ROOM_HISTORY_MOD_FILE = 'room-history.cjs';

export interface ScreepServerGuiOptions {
    port?: number;
    host?: string;
}

export interface ScreepServerOptions {
    path: string;
    logdir: string;
    port: number;
    modfile?: string;
    /** Start @screeps/backend HTTP server so the desktop client can connect. */
    gui?: boolean | ScreepServerGuiOptions;
    /** Enable room history recording so the GUI client can replay room states. */
    enableHistory?: boolean;
    /** Directory to store room history chunks. Default: <path>/room-history. */
    historyDir?: string;
    /** Maximum ticks of history to retain per room. 0 = unlimited. Default: 0. */
    preserveLastNTicks?: number;
    /** Path to a custom db.json to use as the initial database instead of the built-in asset. */
    db?: string;
}

export default class ScreepsServer extends EventEmitter {
    driver: any;
    config: any;
    common: any;
    constants: any;
    connected: boolean;
    processes: {[name: string]: cp.ChildProcess};
    world: World;
    opts: ScreepServerOptions;

    _guiBotUsernames: string[];
    _guiBotBadges: Record<string, object>;
    private _guiSteamId?: string;

    private usersQueue?: any;
    private roomsQueue?: any;

    /*
        Constructor.
    */
    constructor(opts: Partial<ScreepServerOptions> = {}) {
        super();
        this.common = common;
        this.driver = driver;
        this.config = common.configManager.config;
        this.constants = this.config.common.constants;
        this.connected = false;
        this.processes = {};
        this._guiBotUsernames = [];
        this._guiBotBadges = {};
        this.world = new World(this);
        this.opts = this.computeDefaultOpts(opts);
    }

    /*
        Define server options and set defaults.
    */
    private computeDefaultOpts(opts: Partial<ScreepServerOptions>): ScreepServerOptions {
        // When GUI is enabled the HTTP server claims 21025, so storage must use a different port.
        const defaultStoragePort = opts.gui ? 21027 : 21025;
        const defaults: ScreepServerOptions = {
            path:   path.resolve('server'),
            logdir: path.resolve('server', 'logs'),
            modfile: path.resolve('server', MOD_FILE),
            port:   defaultStoragePort,
        };

        const options = _.defaults(opts, defaults) as ScreepServerOptions;
        if (!options.historyDir) {
            options.historyDir = path.resolve(options.path, 'room-history');
        }
        // Define environment parameters
        process.env.MODFILE = options.modfile;
        process.env.DRIVER_MODULE = '@screeps/driver';
        process.env.STORAGE_PORT = `${options.port}`;
        return options;
    }

    /*
        Set the current server options. Missing values will use defaults
    */
    setOpts(opts: ScreepServerOptions) {
        this.opts = this.computeDefaultOpts(opts);
        return this;
    }

    /*
        Get the current server options.
    */
    getOpts(): ScreepServerOptions {
        return this.opts;
    }

    get guiSteamId(): string | undefined {
        return this._guiSteamId;
    }

    /*
        Register a bot username as a GUI bot (links it to the local Steam account).
        badge is optional; if provided it is stored alongside the Steam link.
        - greenworks mode: Steam ID already known — update DB immediately.
        - STEAM_KEY mode: Steam ID unknown — enqueue for the _onSteamId hook.
    */
    _registerGuiBot(username: string, badge?: object | null) {
        this._guiBotUsernames.push(username);
        if (badge) this._guiBotBadges[username] = badge;
        if (this._guiSteamId) {
            const $set: any = { steam: { id: this._guiSteamId } };
            if (badge) $set.badge = badge;
            return common.storage.db['users'].update({ username }, { $set });
        }
    }

    /*
        Start storage process and connect driver.
    */
    async connect() {
        // Ensure directories exist
        await fs.mkdirAsync(this.opts.path).catch(() => {});
        await fs.mkdirAsync(this.opts.logdir).catch(() => {});
        // Copy assets into server directory
        const dbSource = this.opts.db ? path.resolve(this.opts.db) : path.join(ASSETS_PATH, DB_FILE);
        await Promise.all([
            fs.copyAsync(dbSource, path.join(this.opts.path, DB_FILE)),
            fs.copyAsync(path.join(ASSETS_PATH, MOD_FILE), path.join(this.opts.path, MOD_FILE)),
        ]);
        if (this.opts.enableHistory) {
            await fs.mkdirAsync(this.opts.historyDir!).catch(() => {});
            await fs.copyAsync(path.join(ASSETS_PATH, ROOM_HISTORY_MOD_FILE), path.join(this.opts.path, ROOM_HISTORY_MOD_FILE));
            const modsPath = path.resolve(this.opts.path, MOD_FILE);
            const modsJson = JSON.parse(await fs.readFileAsync(modsPath, 'utf8') as string);
            if (!modsJson.mods.includes(ROOM_HISTORY_MOD_FILE)) {
                modsJson.mods.push(ROOM_HISTORY_MOD_FILE);
            }
            await fs.writeFileAsync(modsPath, JSON.stringify(modsJson, null, '\t'));
        }
        // Start storage process
        this.emit('info', 'Starting storage process.');
        const library = path.resolve(path.dirname(require.resolve('@screeps/storage')), '../bin/start.js');
        const process = await this.startProcess('storage', library, {
            DB_PATH:      path.resolve(this.opts.path, DB_FILE),
            MODFILE:      path.resolve(this.opts.path, MOD_FILE),
            STORAGE_PORT: `${this.opts.port}`,
        });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Could not launch the storage process (timeout).')), 5000);
            process.on('message', (message) => {
                if (message === 'storageLaunched') {
                    clearTimeout(timeout);
                    resolve(undefined);
                }
            });
        });
        // Connect to storage process
        try {
            const oldLog = console.log;
            console.log = _.noop; // disable console
            await driver.connect('main');
            console.log = oldLog; // re-enable console
            this.usersQueue = await driver.queue.create('users');
            this.roomsQueue = await driver.queue.create('rooms');
            this.connected = true;
        } catch (err) {
            throw new Error(`Error connecting to driver: ${(err as any).stack}`);
        }
        return this;
    }

    /*
        Run one tick.

        Emulating @screeps/engine/main.js loop.
    */
    async tick() {
        await driver.notifyTickStarted();
        const users = await driver.getAllUsers();
        await this.usersQueue.addMulti(_.map(users, (user) => user._id.toString()));
        await this.usersQueue.whenAllDone();
        const rooms = await driver.getAllRoomsNames() || [];
        await this.roomsQueue.addMulti(rooms);
        await this.roomsQueue.whenAllDone();
        await driver.commitDbBulk();
        // eslint-disable-next-line global-require
        await require('@screeps/engine/src/processor/global')();
        await driver.commitDbBulk();
        const gameTime = await driver.incrementGameTime();
        await driver.updateAccessibleRoomsList();
        await driver.updateRoomStatusData();
        await driver.notifyRoomsDone(gameTime);
        await (driver.config as any).mainLoopCustomStage();
        return this;
    }

    /*
        Start a child process with environment.
    */
    async startProcess(name: string, execPath: string, env: NodeJS.ProcessEnv) {
        const fd = await fs.openAsync(path.resolve(this.opts.logdir, `${name}.log`), 'a');
        this.processes[name] = cp.fork(path.resolve(execPath), [], { stdio: [0, fd, fd, 'ipc'], env });
        this.emit('info', `[${name}] process ${this.processes[name].pid} started`);
        this.processes[name].on('exit', async (code, signal) => {
            await fs.closeAsync(fd);
            if (code && code !== 0) {
                this.emit('error', `[${name}] process ${this.processes[name].pid} exited with code ${code}, restarting...`);
                this.startProcess(name, execPath, env);
            } else if (code === 0) {
                this.emit('info', `[${name}] process ${this.processes[name].pid} stopped`);
            } else {
                this.emit('info', `[${name}] process ${this.processes[name].pid} exited by signal ${signal}`);
            }
        });
        return this.processes[name];
    }

    /*
        Start processes and connect driver.
    */
    async start() {
        // eslint-disable-next-line global-require
        this.emit('info', `Server version ${require('screeps').version}`);
        if (!this.connected) {
            await this.connect();
        }
        this.emit('info', 'Starting engine processes.');
        this.startProcess('engine_runner', path.resolve(path.dirname(require.resolve('@screeps/engine')), 'runner.js'), {
            DRIVER_MODULE: '@screeps/driver',
            MODFILE:       path.resolve(this.opts.path, MOD_FILE),
            STORAGE_PORT:  `${this.opts.port}`,
        });
        this.startProcess('engine_processor', path.resolve(path.dirname(require.resolve('@screeps/engine')), 'processor.js'), {
            DRIVER_MODULE: '@screeps/driver',
            MODFILE:       path.resolve(this.opts.path, MOD_FILE),
            STORAGE_PORT:  `${this.opts.port}`,
            ...(this.opts.enableHistory && {
                HISTORY_DIR:            this.opts.historyDir,
                HISTORY_PRESERVE_TICKS: String(this.opts.preserveLastNTicks || 0),
            }),
        });

        // Need to pre-initiailize the Room Status cache
        await driver.updateAccessibleRoomsList();
        await driver.updateRoomStatusData();

        if (this.opts.gui) {
            await this._startGuiServer();
        }

        return this;
    }

    /*
        Start the @screeps/backend HTTP server so the desktop client can connect.
        gui option: true | { port?: number; host?: string }
    */
    private async _startGuiServer() {
        const gui = typeof this.opts.gui === 'object' ? this.opts.gui : {} as ScreepServerGuiOptions;
        const gamePort = gui.port || 21025;
        const gameHost = gui.host || '0.0.0.0';

        process.env.GAME_PORT = String(gamePort);
        process.env.GAME_HOST = gameHost;
        process.env.CLI_PORT  = String(gamePort + 1);
        process.env.CLI_HOST  = '127.0.0.1';
        process.env.ASSET_DIR = this.opts.path;
        process.env.MODFILE   = path.resolve(this.opts.path, MOD_FILE);

        const backend: any = require('@screeps/backend');
        common.configManager.config.backend.welcomeText = '';
        try {
            const gwPath = path.resolve(path.dirname(backend), '../greenworks/greenworks');
            const gw = require(gwPath);
            if (gw.isSteamRunning() && gw.initAPI()) {
                this._guiSteamId = gw.getSteamId().getRawSteamID();
                gw.initAPI = () => true;
            }
        } catch (_e) {
            // no greenworks — STEAM_KEY mode, Steam ID unknown
        }

        if (!this._guiSteamId) {
            const serverRef = this;
            common.configManager.config.backend._onSteamId = function(steamId: string) {
                common.configManager.config.backend._onSteamId = null;
                serverRef._guiSteamId = steamId;
                const usernames = serverRef._guiBotUsernames;
                return common.storage.db['users']
                    .find({ username: { $in: usernames } })
                    .then((users: any[]) => Promise.all(
                        users.map((u: any) => {
                            const $set: any = { steam: { id: steamId } };
                            const badge = serverRef._guiBotBadges[u.username];
                            if (badge) $set.badge = badge;
                            return common.storage.db['users'].update({ _id: u._id }, { $set });
                        })
                    ));
            };
        }

        if (this.opts.enableHistory) {
            const nativeFs = require('fs');
            const histDir = this.opts.historyDir;
            common.configManager.config.backend.onGetRoomHistory = function(roomName: string, baseTime: string, callback: (err: any, data?: any) => void) {
                const roomDir = path.resolve(histDir!, roomName);
                nativeFs.readFile(path.resolve(roomDir, baseTime + '.json'), { encoding: 'utf8' }, (err: any, data: string) => {
                    if (!err) return callback(null, data);
                    nativeFs.readdir(roomDir, (err2: any, files: string[]) => {
                        if (err2) return callback(err);
                        const requestedBase = parseInt(baseTime, 10);
                        const best = files
                            .filter((f: string) => /^\d+\.json$/.test(f))
                            .map((f: string) => parseInt(f, 10))
                            .filter((t: number) => t <= requestedBase)
                            .sort((a: number, b: number) => b - a)[0];
                        if (best == null) return callback(err);
                        nativeFs.readFile(path.resolve(roomDir, best + '.json'), { encoding: 'utf8' }, callback);
                    });
                });
            };
            this.emit('info', `Room history enabled, writing to: ${histDir}`);
        }

        const startPromise = backend.start();
        this.emit('info', `GUI server: http://localhost:${gamePort} (Steam ID: ${this._guiSteamId || 'pending first sign-in'})`);
        return startPromise;
    }

    /*
        Stop most processes (it is not perfect though as some remain).
    */
    stop(): Promise<any> {
        const engineProcs = Object.entries(this.processes)
            .filter(([name]) => name !== 'storage')
            .map(([, proc]) => proc);
        engineProcs.forEach(p => p.kill());
        const enginesDone = Promise.all(engineProcs.map(proc =>
            new Promise<void>((resolve) => {
                if ((proc as any).exitCode !== null) { resolve(); return; }
                proc.once('exit', resolve);
            })
        ));

        if (this.opts.gui) {
            const backend: any = require('@screeps/backend');
            return Promise.all([enginesDone.then(() => this.stopStorage()), backend.stop()]);
        }
        return enginesDone.then(() => this.stopStorage());
    }

    private stopStorage(): Promise<void> {
        const storageProc = this.processes['storage'];
        if (!storageProc) return Promise.resolve();
        const storage = this.common.storage as any;
        storage._socket?.destroy();
        storage._connected = false;
        storageProc.kill();
        return new Promise<void>((resolve) => {
            if ((storageProc as any).exitCode !== null) { resolve(); return; }
            storageProc.once('exit', resolve);
        });
    }
}
