// Mobile secondary actions live in the "More actions" bottom sheet.
export async function mobileAction(page, name, role = 'button') {
  const sheet = page.locator('#workspace-menu');
  if (!await sheet.evaluate(element => element.open)) await page.getByRole('button', { name: 'More actions' }).click();
  return role === 'label' ? sheet.getByLabel(name, { exact: true }) : sheet.getByRole(role, { name, exact: true });
}
