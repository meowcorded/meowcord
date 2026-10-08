import { MigrationInterface, QueryRunner } from "typeorm";

// encryption can no longer be switched off for a chat, so the column that recorded it goes away. Chats that had been
// switched off are encrypted again with their next message.
export class DropE2eeOptOut1791940000000 implements MigrationInterface {
    name = "DropE2eeOptOut1791940000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "channels" DROP COLUMN IF EXISTS "e2ee_disabled_at"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "e2ee_disabled_at" TIMESTAMP WITH TIME ZONE`);
    }
}
