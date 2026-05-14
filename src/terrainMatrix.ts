import * as _ from 'lodash';

type TerrainTypes = 'plain'|'wall'|'swamp';
const TYPES: TerrainTypes[] = ['plain', 'wall', 'swamp'];

export default class Matrix {
    private data: {[coords: string]: TerrainTypes};

    /**
        Constructor
    */
    constructor() {
        this.data = {};
    }

    /**
        Getters
    */
    get(x: number, y: number): TerrainTypes {
        return _.get(this.data, `${x}:${y}`, 'plain');
    }

    /**
        Setters
    */
    set(x: number, y: number, value: TerrainTypes): this {
        _.set(this.data, `${x}:${y}`, value);
        return this;
    }

    /**
        Serialize the terrain for database storage
    */
    serialize(): string {
        let str = '';
        for (let y = 0; y < 50; y += 1) {
            for (let x = 0; x < 50; x += 1) {
                const terrain = this.get(x, y);
                const mask = TYPES.indexOf(terrain);
                if (mask !== -1) {
                    str += mask;
                } else {
                    throw new Error(`invalid terrain type: ${terrain}`);
                }
            }
        }
        return str;
    }

    /**
        Return a string representation of the matrix
    */
    static unserialize(str: string): Matrix {
        const matrix = new Matrix();
        _.each(str.split(''), (char, idx) => {
            const x = idx % 50;
            const y = Math.floor(idx / 50);
            const bits = parseInt(char, 10);
            if (isNaN(bits)) {
                throw new Error(`invalid terrain mask: ${char}`);
            }
            // Use bitwise decode: MASK_WALL=1 takes priority over TERRAIN_MASK_SWAMP=2
            let terrain: TerrainTypes;
            if (bits & 1) {
                terrain = 'wall';
            } else if (bits & 2) {
                terrain = 'swamp';
            } else {
                terrain = 'plain';
            }
            if (terrain !== 'plain') {
                matrix.set(x, y, terrain);
            }
        });
        return matrix;
    }
}
