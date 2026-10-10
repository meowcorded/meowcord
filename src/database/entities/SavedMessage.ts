import { Column, Entity, JoinColumn, ManyToOne, Unique } from "typeorm";
import { BaseClass } from "./BaseClass";
import { User } from "./User";
import { Channel } from "./Channel";
import { Message } from "./Message";

@Entity({
    name: "saved_messages",
})
@Unique("UQ_saved_message_user_message", ["user_id", "message_id"])
export class SavedMessage extends BaseClass {
    @Column()
    user_id: string;

    @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_saved_message_user_id" })
    @ManyToOne(() => User, { onDelete: "CASCADE" })
    user: User;

    @Column()
    channel_id: string;

    @JoinColumn({ name: "channel_id", foreignKeyConstraintName: "FK_saved_message_channel_id" })
    @ManyToOne(() => Channel, { onDelete: "CASCADE" })
    channel: Channel;

    @Column()
    message_id: string;

    @JoinColumn({ name: "message_id", foreignKeyConstraintName: "FK_saved_message_message_id" })
    @ManyToOne(() => Message, { onDelete: "CASCADE" })
    message: Message;

    @Column({ type: "timestamp with time zone", default: () => "now()" })
    saved_at: Date;

    @Column({ type: "timestamp with time zone", nullable: true })
    due_at: Date | null;

    @Column({ type: "varchar", nullable: true })
    notes: string | null;
}
