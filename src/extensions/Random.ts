import { randomBytes, randomInt } from "node:crypto";

const DOUBLE_SCALE = 2 ** 48;

export class Random {
    public static nextInt(min?: number, max?: number): number {
        if (min === undefined && max === undefined) return randomInt(DOUBLE_SCALE - 1);
        if (max === undefined) {
            if (min! <= 0) throw new RangeError("min must be greater than 0");
            return randomInt(min!);
        }
        if (min! >= max) throw new RangeError("min must be less than max");
        return randomInt(min!, max);
    }

    public static nextDouble(min?: number, max?: number): number {
        const unit = randomInt(DOUBLE_SCALE - 1) / DOUBLE_SCALE;
        if (min === undefined && max === undefined) return unit;
        if (max === undefined) {
            if (min! <= 0) throw new RangeError("min must be greater than 0");
            return unit * min!;
        }
        if (min! >= max) throw new RangeError("min must be less than max");
        return unit * (max - min!) + min!;
    }

    public static nextBytes(count: number): Uint8Array {
        if (count <= 0) throw new RangeError("count must be greater than 0");
        return new Uint8Array(randomBytes(count));
    }

    public static nextBytesArray(count: number) {
        if (count <= 0) throw new RangeError("count must be greater than 0");
        return [...randomBytes(count)];
    }

    public static getItems<T>(items: T[], count: number): T[] {
        if (count <= 0) throw new RangeError("count must be greater than 0");
        return this.shuffle(items).slice(0, count);
    }

    public static shuffle<T>(items: T[]): T[] {
        const array = [...items];
        for (let i = array.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    public static getString(choices: string, length: number) {
        const chars = [...choices];
        return Array.from({ length }, () => chars[randomInt(chars.length)]).join("");
    }

    public static getHexString(length: number) {
        return this.getString("0123456789ABCDEF", length);
    }
}
