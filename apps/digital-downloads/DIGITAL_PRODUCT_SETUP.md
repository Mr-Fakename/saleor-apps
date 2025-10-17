# Digital Product Setup Guide

This guide explains how to properly configure products for digital downloads in Saleor.

## Problem: All Products with Images Treated as Digital

Previously, the app detected digital products by checking for any media (images, files, etc.). This meant **any product with a product image would be treated as a digital download**, which is problematic for a regular e-commerce store.

## Solution: Explicit Digital Product Marking

The app now uses **explicit markers** to identify digital products:

### Method 1: Product Type (Recommended)

1. Go to **Saleor Dashboard** → **Configuration** → **Product Types**
2. Create or edit a product type (e.g., "Digital Downloads", "eBooks", "Software")
3. **Check the "Is this product shippable?" box** → Set to **NO** (marks it as digital)
4. Save the product type
5. Assign this product type to your digital products

**Advantages:**
- Clean, built-in Saleor feature
- Easy to manage in bulk
- Clear separation between physical and digital products

### Method 2: Product Metadata

If you can't use product types, use metadata:

1. Go to **Saleor Dashboard** → **Products** → Select your product
2. Scroll to **Metadata** section
3. Add a new metadata entry:
   - **Key**: `digital_download`
   - **Value**: `true`
4. Save the product

**Advantages:**
- Works for individual products
- Can be set via API/GraphQL
- Flexible for mixed product types

### Method 3: Variant Metadata

For products where only specific variants are digital:

1. Go to **Saleor Dashboard** → **Products** → Select your product → **Variants**
2. Select the variant
3. Scroll to **Metadata** section
4. Add a new metadata entry:
   - **Key**: `digital_download`
   - **Value**: `true`
5. Save the variant

**Advantages:**
- Variant-level control
- Good for products with both physical and digital variants

## Detection Priority

The app checks in this order:

1. **Product Type `isDigital` flag** (highest priority)
2. **Product metadata** `digital_download=true`
3. **Variant metadata** `digital_download=true` (lowest priority)

## Adding Downloadable Files

Once a product is marked as digital, you can add the actual downloadable files using **two methods**:

### Method A: File Upload Attributes (Recommended for Variant-Specific Files)

This is the best method when different variants need different files (e.g., different eBook formats, sizes, or versions).

1. **Create a File Attribute** (one-time setup):
   - Go to **Configuration** → **Attributes** → **Product Attributes**
   - Click **Create Attribute**
   - Name: "Digital File" (or similar)
   - **Attribute Type**: Choose **File**
   - **Value Required**: Check if mandatory
   - Assign to your digital product types

2. **Upload Files to Variants**:
   - Go to your product → **Variants** tab
   - Select a variant
   - Scroll to **Attributes** section
   - Find your "Digital File" attribute
   - Click **Upload File** and select your file (PDF, ZIP, etc.)
   - Save the variant

**Advantages:**
- Each variant can have its own file
- Clean dashboard workflow for non-technical users
- Files are clearly organized in variant attributes
- Supports multiple file formats per variant

### Method B: Media Tab (For Shared Files)

This method works when all variants share the same downloadable file.

1. Go to the product's **Media** tab (or variant's Media tab)
2. Upload your digital files (PDFs, ZIPs, images, etc.)
3. The first media file will be used as the download

**Note:** You can add media to:
- **Product level** - all variants share the same file
- **Variant level** - each variant has its own file

## File Detection Priority

The app checks for downloadable files in this order:

1. **Variant attributes with file type** (highest priority)
2. **Variant media**
3. **Product media** (lowest priority)

## Example Workflow

### Setting up an eBook for sale:

1. **Create/Edit Product Type**:
   - Name: "Digital Books"
   - Is shippable: NO
   - Create a File attribute called "eBook File"

2. **Create Product**:
   - Product Type: Digital Books
   - Add product details (name, description, price)

3. **Add Variants with Files**:
   - Create variants (e.g., PDF format, EPUB format)
   - For each variant, upload the file via the "eBook File" attribute
   - OR use the Media tab if all variants share the same file

4. **Test**:
   - Create a test order
   - Mark it as fully paid
   - Check console logs for the download URL
   - Copy and test the download link

## Common Issues

### Issue: Regular products being treated as digital

**Solution**: Products with images are NO LONGER treated as digital automatically. Only products explicitly marked (via product type or metadata) are considered digital.

### Issue: Digital product not detected

**Checklist:**
- [ ] Product type has `isShippable = false` OR
- [ ] Product has metadata `digital_download=true` OR
- [ ] Variant has metadata `digital_download=true`
- [ ] Product/variant has media files uploaded
- [ ] Webhook logs show the product details (check `isDigital` flag)

### Issue: No download email sent

**Note**: The current implementation creates download tokens but does NOT send emails automatically. Email functionality needs to be implemented separately (see the SMTP app or integrate with a service like SendGrid/Mailgun).

## For Developers

The digital product detection logic is in:
```
src/app/api/webhooks/saleor/order-fully-paid/use-case.ts
```

Function: `hasDigitalFiles(line)`

To customize detection logic, modify this function. The GraphQL query that fetches product data is in:
```
graphql/subscriptions/order-fully-paid.graphql
```

After modifying the GraphQL query, regenerate types with:
```bash
pnpm generate
```
