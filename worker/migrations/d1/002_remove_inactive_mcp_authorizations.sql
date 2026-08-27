CREATE TABLE `_inactive_mcp_authorization_cleanup` (
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `client_id`)
);
--> statement-breakpoint
INSERT INTO `_inactive_mcp_authorization_cleanup` (`user_id`, `client_id`)
SELECT consent.user_id, consent.client_id
FROM oauth_consent AS consent
JOIN oauth_client AS client ON client.client_id = consent.client_id
WHERE consent.user_id IS NOT NULL
	AND json_valid(consent.scopes)
	AND EXISTS (
		SELECT 1 FROM json_each(consent.scopes) AS consent_scope
		WHERE consent_scope.value = 'yepnope:questions'
	)
	AND (
		client.disabled = 1
		OR NOT EXISTS (
			SELECT 1 FROM oauth_refresh_token AS refresh
			WHERE refresh.user_id = consent.user_id
				AND refresh.client_id = consent.client_id
				AND refresh.revoked IS NULL
				AND refresh.expires_at > cast(unixepoch('subsecond') * 1000 as integer)
				AND json_valid(refresh.scopes)
				AND EXISTS (
					SELECT 1 FROM json_each(refresh.scopes) AS refresh_scope
					WHERE refresh_scope.value = 'yepnope:questions'
				)
				AND json_valid(refresh.resources)
				AND json_valid(consent.resources)
				AND EXISTS (
					SELECT 1
					FROM json_each(refresh.resources) AS refresh_resource
					JOIN json_each(consent.resources) AS consent_resource
						ON consent_resource.value = refresh_resource.value
				)
		)
	);
--> statement-breakpoint
DELETE FROM verification
WHERE json_valid(value)
	AND json_extract(value, '$.type') = 'authorization_code'
	AND EXISTS (
		SELECT 1 FROM `_inactive_mcp_authorization_cleanup` AS inactive
		WHERE inactive.user_id = json_extract(verification.value, '$.userId')
			AND inactive.client_id = json_extract(verification.value, '$.query.client_id')
	);
--> statement-breakpoint
DELETE FROM mcp_client_use
WHERE EXISTS (
	SELECT 1 FROM `_inactive_mcp_authorization_cleanup` AS inactive
	WHERE inactive.user_id = mcp_client_use.user_id
		AND inactive.client_id = mcp_client_use.client_id
);
--> statement-breakpoint
DELETE FROM oauth_access_token
WHERE EXISTS (
	SELECT 1 FROM `_inactive_mcp_authorization_cleanup` AS inactive
	WHERE inactive.user_id = oauth_access_token.user_id
		AND inactive.client_id = oauth_access_token.client_id
);
--> statement-breakpoint
DELETE FROM oauth_refresh_token
WHERE EXISTS (
	SELECT 1 FROM `_inactive_mcp_authorization_cleanup` AS inactive
	WHERE inactive.user_id = oauth_refresh_token.user_id
		AND inactive.client_id = oauth_refresh_token.client_id
);
--> statement-breakpoint
DELETE FROM oauth_consent
WHERE EXISTS (
	SELECT 1 FROM `_inactive_mcp_authorization_cleanup` AS inactive
	WHERE inactive.user_id = oauth_consent.user_id
		AND inactive.client_id = oauth_consent.client_id
);
--> statement-breakpoint
DROP TABLE `_inactive_mcp_authorization_cleanup`;
