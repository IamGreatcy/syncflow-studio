export declare class SecretCipher {
    private readonly key;
    constructor(keyHexOrPath?: string);
    encrypt(plaintext: string | null | undefined): string | null;
    decrypt(ciphertext: string | null | undefined): string | null;
}
//# sourceMappingURL=crypto.d.ts.map