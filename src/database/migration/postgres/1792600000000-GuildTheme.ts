/* SPDX-License-Identifier: AGPL-3.0-only */
import { MigrationInterface, QueryRunner } from "typeorm";

export class GuildTheme1792600000000 implements MigrationInterface {
    name = "GuildTheme1792600000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "guilds" ADD COLUMN IF NOT EXISTS "theme" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "guilds" DROP COLUMN IF EXISTS "theme"`);
    }
}
