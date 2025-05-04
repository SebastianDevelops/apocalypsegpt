import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthkitHandler } from "./authkit-handler";
import type { Props } from "./props";

import { Permit } from "permitio";
import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";

export class MyMCP extends McpAgent<Env, unknown, Props> {
	prisma = new PrismaClient().$extends(withAccelerate());
	
	permit = new Permit({
		pdp: this.env.PERMIT_PDP_URL!,
		token: this.env.PERMIT_API_KEY!,
	});

  server = new McpServer({
    name: "Zombify",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "createPolicy",
	  "Create a new survivor role (e.g., Scavenger, Medic, Guard) along with its permissions such as access to unique abilities, world interactions, or narrative branches.",
      {
        roleKey: z.string(),
        permissions: z.array(
          z.object({ resource: z.string(), actions: z.array(z.string()) })
        ),
      },
      async ({ roleKey, permissions }) => {
        await this.permit.api.createRole({ key: roleKey, name: roleKey });

        for (const { resource, actions } of permissions) {
          const actionsObject = actions.reduce((acc, action) => {
            acc[action] = {};
            return acc;
          }, {} as Record<string, {}>);

          await this.permit.api.resources.create({
            key: resource,
            name: resource,
            actions: actionsObject,
          });
          const permissionGrants = actions.map(
            (action) => `${resource}:${action}`
          );
          await this.permit.api.roles.update(roleKey, {
            permissions: permissionGrants,
          });
        }
        return {
          content: [{ type: "text", text: `Policy ${roleKey} created` }],
        };
      }
    );

    this.server.tool(
		"Completely remove a survivor role and its permissions from the game world and narrative system.",
		{ roleKey: z.string() },
      async ({ roleKey }) => {
        await this.permit.api.deleteRole(roleKey);
        return {
          content: [{ type: "text", text: `Policy ${roleKey} deleted` }],
        };
      }
    );

    this.server.tool(
      "addUserToPolicy",
	  "Assign a survivor (player) to a specific role, granting them access to that role's abilities and interactive narrative functions (e.g., allow Scavenger to 'search_ruins').",
      { userId: z.string(), roleKey: z.string(), tenant: z.string() },
      async ({ userId, roleKey, tenant }) => {
        await this.permit.api.assignRole({
          user: userId,
          role: roleKey,
          tenant,
        });
        return {
          content: [
            { type: "text", text: `User ${userId} added to ${roleKey}` },
          ],
        };
      }
    );

	this.server.tool(
		"getUserAvailableRolesAndPermissions",
		"Get a survivors (player) roles and permissions to perform an action on their input",
		async () => {
		  let userId = this.props.user.id;
		  var user = await this.permit.api.getUser(userId);
		  const permissions = await this.permit.getUserPermissions(user);
		  var userRoles = user.roles;

		  return {
			content: [
			  { type: "text", text: `User ${userId} permissions: ${JSON.stringify(permissions)} and roles: ${JSON.stringify(userRoles)}` }
			]
		  };
		}
	);

	this.server.tool(
		"doesUserHaveAccess",
		"Check whether a survivor (player) currently has the required role and permissions to perform a requested action (e.g., 'fortify_position' by Guard). You can use getUserAvailableRolesAndPermissions tool to find these.",
		{ action: z.string(), resource: z.string() },
		async ({ action, resource }) => {
		  let userId = this.props.user.id;
		  var user = await this.permit.api.getUser(userId);

		  var check = await this.permit.check(user, action, resource);
		  return {
			content: [
			  { type: "text", text: `Permission to perform ${action} for user is ${check}` },
			],
		  };
		}
	  );

	  this.server.tool(
		"getCurrentUserId",
		"Fetch the current survivor's unique userId to enable story progression, role assignment, or world state updates.",
		async () => {
		  const userId = this.props.user.id;
		  // This tool should return the user ID as requested by the description.
		  // The previous implementation loaded and returned game state, which is incorrect for this tool.
		  return {
			content: [
			  { type: "text", text: `Current user ID is: ${userId}` }
			]
		  };
		}
	  );
	
	this.server.tool(
		"getCurrentGameState",
		"Retrieve the player's current world state, including memory, inventory, and ongoing quest context. Used to continue or reactivate their story from where it left off.",
		async () => {
		  const userId = this.props.user.id;
		  const record = await this.prisma.storyState.findUnique({
			where: { userId }
		  });
	  
		  if (!record) {
			return {
			  content: [
				{ type: "text", text: "No existing game state found." },
				// Return state as text/json as 'state' type is not standard
				{ type: "text", text: JSON.stringify({}) }
			  ]
			};
		  }
	  
		  const state = {
			memory: record.memory ?? {},
			inventory: record.inventory ?? {},
			currentQuest: record.currentQuest ?? null
		  };
		  return {
			content: [
			  { type: "text", text: "Loaded existing game state." },
			  // Return state as text/json as 'state' type is not standard
			  { type: "text", text: JSON.stringify(state) }
			]
		  };
		}
	  ); 

	  this.server.tool(
		"updateGameState",
		"Save the player's updated story state (memory, inventory, quest progress) to persist procedural outcomes or crafted items.",
		{
		  userId: z.string(),
		  newState: z.string()
		},
		async ({ userId, newState }) => {
		  // Update only the fields provided in newState
		  const parsed = JSON.parse(newState);
		  const record = await this.prisma.storyState.update({              
			where: { userId },
			data: {
			  memory: parsed.memory,
			  inventory: parsed.inventory,
			  currentQuest: parsed.currentQuest
			}
		  });
	  
		  return {
			content: [
			  { type: "text", text: `Game state updated for user ${userId}.` },
			  // Return state as text/json as 'state' type is not standard
			  { type: "text", text: JSON.stringify({
				  memory: record.memory,
				  inventory: record.inventory,
				  currentQuest: record.currentQuest
			  }) }
			]
		  };
		}
	  );
	  
	  this.server.tool(
		"ensureUser",
		"Ensure that the survivor (player) exists in both the permission system and game database. Create if they are a new character entering the world.",
		{ email: z.string().optional() },
		async ({ email }) => {
		  // 1️⃣ Check Permit.io for existing user
		  let userId = this.props.user.id; 
		  try {
			await this.permit.api.users.get(userId);              
		  } catch (err: any) {
			// 2️⃣ If not found, create in Permit.io
			if (err.status === 404 || err.code === "NotFound") {
			  await this.permit.api.syncUser({                    
				key: userId,
				email: email,
				first_name: "",
				last_name: "",
				attributes: {}
			  });
			} else {
			  throw err;
			}
		  }
	  
		  // 3️⃣ Mirror into your Postgres via upsert
		  await this.prisma.user.upsert({                         
			where: { auth0Sub: userId },
			update: {},
			create: { auth0Sub: userId, email: email ?? null }
		  });
	  
		  return {
			content: [
			  { type: "text", text: `User ${userId} is ensured in DB and Permit.io.` }
			]
		  };
		}
	  );
  }
}



export default new OAuthProvider({
  apiRoute: "/sse",
  apiHandler: MyMCP.mount("/sse") as any,
  defaultHandler: AuthkitHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
