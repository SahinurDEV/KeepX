import type { PushDeviceDto } from "@vela/shared";
import { HttpError, isDuplicateKey } from "../http.js";
import { PushDevice } from "../models.js";

const DEVICE_LIMIT = 10;

export async function listDevices(userId: string): Promise<PushDeviceDto[]> {
  const rows = await PushDevice.find({ userId }).sort({ createdAt: -1 });
  return rows.map(toDeviceDto);
}

export async function registerDevice(
  userId: string,
  input: { platform: "web" | "android" | "ios"; token: string },
): Promise<{ device: PushDeviceDto; created: boolean }> {
  const provider = input.platform === "web" ? "web" : "expo";
  const existing = await PushDevice.findOne({ token: input.token });
  if (existing) {
    if (existing.userId.toString() !== userId) throw new HttpError(409, "DEVICE_TAKEN", "That device is already registered.");
    return { device: toDeviceDto(existing), created: false };
  }
  const count = await PushDevice.countDocuments({ userId });
  if (count >= DEVICE_LIMIT) throw new HttpError(400, "DEVICE_LIMIT", "Remove a device before adding another. The limit is 10.");
  try {
    const created = await PushDevice.create({ userId, platform: input.platform, provider, token: input.token });
    return { device: toDeviceDto(created), created: true };
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, "DEVICE_TAKEN", "That device is already registered.");
    throw error;
  }
}

export async function removeDevice(
  userId: string,
  deviceId: string,
): Promise<{ platform: "web" | "android" | "ios"; token: string }> {
  if (!/^[a-f\d]{24}$/i.test(deviceId)) throw new HttpError(404, "NOT_FOUND", "Device not found.");
  const row = await PushDevice.findOneAndDelete({ _id: deviceId, userId });
  if (!row) throw new HttpError(404, "NOT_FOUND", "Device not found.");
  return { platform: row.platform as "web" | "android" | "ios", token: row.token };
}

function toDeviceDto(row: { _id: { toString(): string }; platform: string; createdAt: Date }): PushDeviceDto {
  return {
    id: row._id.toString(),
    platform: row.platform as PushDeviceDto["platform"],
    createdAt: row.createdAt.toISOString(),
  };
}
