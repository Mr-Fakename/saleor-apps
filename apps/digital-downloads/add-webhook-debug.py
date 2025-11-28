with open("src/app/api/webhooks/saleor/order-fully-paid/use-case.ts", "r", encoding="utf-8") as f:
    lines = f.readlines()

# Find the line "order.lines.forEach((line, index) => {"
insert_after = None
for i, line in enumerate(lines):
    if "order.lines.forEach((line, index) => {" in line:
        insert_after = i
        break

if insert_after is not None:
    # Insert debug logging after the forEach line
    debug_lines = [
        '        console.log("=" + "=".repeat(79));\n',
        '        console.log(`WEBHOOK DEBUG - Order Line ${index + 1}`);\n',
        '        console.log("Product:", line.productName);\n',
        '        console.log("Variant:", line.variantName);\n',
        '        console.log("\nVARIANT ATTRIBUTES:");\n',
        '        console.log(JSON.stringify(line.variant?.attributes, null, 2));\n',
        '        console.log("\nPRODUCT ATTRIBUTES:");\n',
        '        console.log(JSON.stringify(line.variant?.product?.attributes, null, 2));\n',
        '        console.log("=" + "=".repeat(79));\n',
        '\n',
    ]
    
    new_lines = lines[:insert_after+1] + debug_lines + lines[insert_after+1:]
    
    with open("src/app/api/webhooks/saleor/order-fully-paid/use-case.ts", "w", encoding="utf-8") as f:
        f.writelines(new_lines)
    
    print("Debug logging added successfully")
else:
    print("Could not find forEach line")
