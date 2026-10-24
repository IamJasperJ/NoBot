CREATE TABLE `room_message_index` (
	`room_id` text NOT NULL,
	`message_id` text NOT NULL,
	`seq` integer NOT NULL,
	PRIMARY KEY(`room_id`, `message_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_message_index_seq_idx` ON `room_message_index` (`room_id`,`seq`);
--> statement-breakpoint
INSERT INTO room_message_index (room_id, message_id, seq)
SELECT e.room_id, e.entity_id, min(e.seq)
FROM room_events e JOIN messages m ON m.id = e.entity_id
WHERE e.type IN ('room.message', 'room.generation') AND json_type(e.payload, '$.message') = 'object'
GROUP BY e.room_id, e.entity_id;
