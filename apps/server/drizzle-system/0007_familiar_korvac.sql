CREATE TABLE `extension_backgrounds` (
	`user_handle` text NOT NULL,
	`extension_id` text NOT NULL,
	PRIMARY KEY(`user_handle`, `extension_id`),
	FOREIGN KEY (`user_handle`) REFERENCES `users`(`handle`) ON UPDATE no action ON DELETE cascade
);
