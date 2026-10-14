import { expect, test } from "@playwright/test";

test("a signed-in task survives edit, complete, and reload", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;

  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

  const quickAdd = page.locator("form").filter({ has: page.getByLabel("Quick add task") });
  await quickAdd.getByLabel("Quick add task").fill("Buy milk");
  await quickAdd.getByRole("button", { name: "Add" }).click();
  const created = page.getByTestId("task-row").filter({ hasText: "Buy milk" });
  await expect(created).toBeVisible();
  await created.getByRole("button", { name: /Buy milk/ }).click();

  await page.getByLabel("Title").fill("Buy oat milk");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Task saved.")).toBeVisible();

  await page.reload();
  const edited = page.getByTestId("task-row").filter({ hasText: "Buy oat milk" });
  await expect(edited).toBeVisible();
  await edited.getByRole("checkbox", { name: "Complete Buy oat milk" }).click();
  await expect(page.getByTestId("task-row")).toHaveCount(0);

  await page.goto("/completed");
  const completed = page.getByTestId("task-row").filter({ hasText: "Buy oat milk" });
  await expect(completed).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("task-row").filter({ hasText: "Buy oat milk" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Mark open Buy oat milk" })).toBeChecked();
});
