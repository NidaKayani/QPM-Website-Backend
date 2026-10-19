import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 2,
      maxlength: 30
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    bio: {
      type: String,
      default: ""
    },
    avatarUrl: {
      type: String,
      default: ""
    },
    // Bumped by "Regenerate token"; an API token is only valid for the version it was issued under.
    apiTokenVersion: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

userSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    delete ret.apiTokenVersion;
    return ret;
  }
});

export const User = mongoose.model("User", userSchema);
