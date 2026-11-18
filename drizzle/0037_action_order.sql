CREATE TABLE "action_order" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_order_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "action_order" ADD CONSTRAINT "action_order_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;