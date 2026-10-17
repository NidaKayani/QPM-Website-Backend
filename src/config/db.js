import dns from "node:dns";
import mongoose from "mongoose";

export const connectDB = async () => {
  try {
    const connStr = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/qpm_registry";
    console.log(`Connecting to MongoDB at ${connStr.replace(/:([^:@]+)@/, ":****@")} ...`);
    
    // Some local/ISP DNS resolvers refuse the SRV lookups that mongodb+srv:// needs
    // (querySrv ECONNREFUSED on Windows). Use public resolvers for those URIs.
    if (connStr.startsWith("mongodb+srv://")) {
      dns.setServers(["8.8.8.8", "1.1.1.1"]);
    }

    await mongoose.connect(connStr);
    console.log("✅ MongoDB Connected successfully!");
  } catch (error) {
    console.error("❌ MongoDB Connection Error:", error.message);
    console.warn("⚠️ Continuing with in-memory / fallback store if MongoDB is offline...");
  }
};
