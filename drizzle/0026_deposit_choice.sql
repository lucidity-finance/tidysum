CREATE TABLE "deposit_choice" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deposit_choice" ADD CONSTRAINT "deposit_choice_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_choice" ADD CONSTRAINT "deposit_choice_account_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."account"("id","user_id") ON DELETE cascade ON UPDATE no action;