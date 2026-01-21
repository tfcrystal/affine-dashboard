# Easy script: print total size of Hugging Face model using web scraping
# Works on Ubuntu/Linux

import requests
import re

def get_model_total_size_gb(model_name):
    """
    Scrape Hugging Face model page to get total size.
    Returns size in GB as float.
    Optimized for speed - tries main page first.
    """
    # Fallback to files page if main page doesn't have it
    url = f"https://huggingface.co/{model_name}/tree/main"
    size_gb = scrape_size_from_url(url, model_name)
    if size_gb is not None:
        return size_gb
    
    return None

def scrape_size_from_url(url, model_name):
    """
    Scrape a specific URL to find the total model size.
    Returns size in GB as float, or None if not found.
    """
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        html_text = response.text
        
        # Find the div containing the model name link, then extract size from adjacent div
        # HTML structure: parent div contains model name link and size div as siblings
        # The size div has specific classes: "mb-2 cursor-default whitespace-nowrap rounded-md border"
        # We need to find the size div that's in the same parent container as the model name
        
        # Escape model_name for regex (handle special characters)
        # Model name might be full path (user/repo) or just repo name in the anchor tag
        escaped_model_name = re.escape(model_name)
        
        # Extract just the repo name part (after last /) for more flexible matching
        repo_name = model_name.split('/')[-1] if '/' in model_name else model_name
        escaped_repo_name = re.escape(repo_name)
        
        # Find all size divs with the specific classes
        # The size div must have all of these classes: mb-2, cursor-default, whitespace-nowrap, rounded-md, border
        # We need to match divs that contain all these classes (order doesn't matter)
        # First, find all divs with class attribute that might be the size div
        div_pattern = r'<div[^>]*class="([^"]*)"[^>]*>(\d+\.?\d*)\s*GB</div>'
        
        # Find all matches of model name in anchor tags
        model_link_pattern = rf'<a[^>]*>({escaped_model_name}|{escaped_repo_name})</a>'
        
        # Find the position of the model name link
        model_match = re.search(model_link_pattern, html_text, re.IGNORECASE)
        if not model_match:
            return None
        
        model_start = model_match.start()
        
        # Find all divs with GB size in them
        all_div_matches = list(re.finditer(div_pattern, html_text, re.IGNORECASE))
        
        # Check each div to see if it has all the required classes
        required_classes = ['mb-2', 'cursor-default', 'whitespace-nowrap', 'rounded-md', 'border']
        for div_match in all_div_matches:
            class_attr = div_match.group(1)
            # Check if all required classes are present (order doesn't matter)
            if all(cls in class_attr for cls in required_classes):
                # This is a size div, check if it's near the model name
                div_start = div_match.start()
                # If it's within 2000 chars after the model name, it's likely the correct one
                if div_start > model_start and div_start < model_start + 2000:
                    try:
                        return float(div_match.group(2))
                    except ValueError:
                        continue
        
        # Fallback: if no size div found near model name, find the closest one
        for div_match in all_div_matches:
            class_attr = div_match.group(1)
            if all(cls in class_attr for cls in required_classes):
                try:
                    return float(div_match.group(2))
                except ValueError:
                    continue
        
        return None
        
    except Exception as e:
        # Use stderr for errors to avoid breaking JSON output when called from batch script
        import sys
        print(f"Error scraping {url}: {e}", file=sys.stderr)
        return None

if __name__ == "__main__":
    import time
    
    # Test with different models
    models = [
        "Sota26/Affine-6-5HpqTamztoLsVqrHKv1aY4auSQKerdLBKHHTfvgebqGynTeq",  # Original test
    ]
    
    for model in models:
        start_time = time.time()
        size_gb = get_model_total_size_gb(model)
        elapsed = time.time() - start_time
        
        if size_gb is not None:
            mb_size = size_gb * 1024
            bytes_size = size_gb * (1024**3)
            print(f"Model: {model}")
            print(f"Total Size: {int(bytes_size)} bytes, {mb_size:.2f} MB, {size_gb:.2f} GB")
            print(f"Time: {elapsed:.2f} seconds")
        else:
            print(f"Model: {model}")
            print("Failed to get total size from scraping")
            print(f"Time: {elapsed:.2f} seconds")
        print("-" * 60)
