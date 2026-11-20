import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export class SecretCipher {
    key;
    constructor(keyHexOrPath) {
        const envHex = process.env.ENCRYPTION_KEY?.trim();
        if (envHex && /^[0-9a-fA-F]{64}$/.test(envHex)) {
            this.key = Buffer.from(envHex, 'hex');
            return;
        }
        if (keyHexOrPath && /^[0-9a-fA-F]{64}$/.test(keyHexOrPath)) {
            this.key = Buffer.from(keyHexOrPath, 'hex');
            return;
        }
        const keyFilePath = keyHexOrPath || path.resolve(process.cwd(), 'data', '.master.key');
        const dir = path.dirname(keyFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (fs.existsSync(keyFilePath)) {
            const stored = fs.readFileSync(keyFilePath, 'utf8').trim();
            if (/^[0-9a-fA-F]{64}$/.test(stored)) {
                this.key = Buffer.from(stored, 'hex');
                return;
            }
        }
        const generated = randomBytes(32);
        fs.writeFileSync(keyFilePath, generated.toString('hex'), {
            encoding: 'utf8',
            mode: 0o600,
        });
        this.key = generated;
    }
    encrypt(plaintext) {
        if (plaintext === null || plaintext === undefined || plaintext === '') {
            return null;
        }
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    }
    decrypt(ciphertext) {
        if (!ciphertext)
            return null;
        if (!ciphertext.startsWith('v1:')) {
            return ciphertext;
        }
        const parts = ciphertext.split(':');
        if (parts.length !== 4) {
            throw new Error('Invalid encrypted secret format');
        }
        const [, ivHex, tagHex, dataHex] = parts;
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(dataHex, 'hex')),
            decipher.final(),
        ]);
        return decrypted.toString('utf8');
    }
}
//# sourceMappingURL=crypto.js.map