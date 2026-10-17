import mongoose from "mongoose";

// One document per package version per UTC day; `count` is incremented on each tarball download.
const downloadStatSchema = new mongoose.Schema({
  package: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Package",
    required: true
  },
  version: {
    type: String,
    required: true
  },
  day: {
    type: String, // "YYYY-MM-DD" (UTC)
    required: true
  },
  count: {
    type: Number,
    default: 0
  }
});

downloadStatSchema.index({ package: 1, version: 1, day: 1 }, { unique: true });
downloadStatSchema.index({ package: 1, day: 1 });

export const DownloadStat = mongoose.model("DownloadStat", downloadStatSchema);
