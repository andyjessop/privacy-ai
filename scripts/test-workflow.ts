import { spawn } from "child_process";

async function main() {
    console.log("🚀 Starting System Verification Workflow");

    // 1. Reset Database
    console.log("\n🧹 Resetting Database...");
    const reset = spawn("bun", ["run", "db:reset"], {
        cwd: "apps/vector",
        stdio: "inherit"
    });

    await new Promise<void>((resolve, reject) => {
        reset.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Database reset failed with code ${code}`));
        });
    });
    console.log("✅ Database reset complete.");

    // 2. Start Services
    const services: any[] = [];
    const killServices = () => {
        console.log("\n🛑 Stopping services...");
        services.forEach(s => s.kill());
    };

    process.on("SIGINT", killServices);
    process.on("exit", killServices);

    try {
        console.log("\n📡 Starting Vector Service (Port 3001)...");
        const vectorService = spawn("bun", ["run", "start"], {
            cwd: "apps/vector",
            stdio: "ignore", // ignore stdout to keep test output clean
            env: { ...process.env, PORT: "3001" }
        });
        services.push(vectorService);
        // Basic wait for startup (could be improved with health check loop)
        await new Promise(r => setTimeout(r, 2000));

        console.log("📡 Starting API Service (Port 3000)...");
        const apiService = spawn("bun", ["run", "start"], {
            cwd: "apps/api",
            stdio: "ignore",
            env: { ...process.env, PORT: "3000", VECTOR_API_URL: "http://localhost:3001" }
        });
        services.push(apiService);
        await new Promise(r => setTimeout(r, 2000));

        console.log("✅ Services running.");

        // 3. Run Tests
        console.log("\n🧪 Running All Tests...");
        // Run tests in parallel or sequential? "bun test" in root runs everything.
        const testing = spawn("bun", ["test"], {
            stdio: "inherit",
            env: { ...process.env, MISTRAL_API_KEY: process.env.MISTRAL_API_KEY } // Ensure key is passed
        });

        await new Promise<void>((resolve, reject) => {
            testing.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Tests failed with code ${code}`));
            });
        });

        console.log("\n🎉 All Verification Steps Passed!");
        process.exit(0);

    } catch (error) {
        console.error("\n❌ Workflow Failed:", error);
        killServices();
        process.exit(1);
    }
}

main();
