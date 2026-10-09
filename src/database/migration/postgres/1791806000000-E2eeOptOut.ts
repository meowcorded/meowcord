import { MigrationInterface, QueryRunner } from "typeorm";

export class E2eeOptOut1791806000000 implements MigrationInterface {
    name = "E2eeOptOut1791806000000";

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "channels" ADD "e2ee_disabled_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "channels" DROP COLUMN "e2ee_disabled_at"`);
    }
}
