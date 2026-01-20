import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uid, chute_id } = req.query;

  if (!uid) {
    return res.status(400).json({ error: 'UID parameter is required' });
  }

  // Use Chutes API to get chute status (requires CHUTES_API_KEY but not AFFINE_API_KEY)
  const chuteIdValue = Array.isArray(chute_id) ? chute_id[0] : chute_id;
  if (!chuteIdValue) {
    return res.status(200).json({ chute_status: null, error: 'chute_id not available' });
  }

  try {
    const chutesApiKey = "cpk_ba403c09fd3b4335ba46e12ae5cd1332.5edb35101cf45f89ae93e416812ff285.aEHD30JT91q7yzKEGqjVsf0gprxnAMwq";
    if (!chutesApiKey) {
      console.warn('CHUTES_API_KEY not configured - cannot fetch chute status');
      return res.status(200).json({ chute_status: null, error: 'CHUTES_API_KEY not configured' });
    }

    const chutesResponse = await fetch(`https://api.chutes.ai/chutes/${chuteIdValue}`, {
      headers: {
        'Authorization': chutesApiKey
      },
      signal: AbortSignal.timeout(5000) // 5 second timeout
    });
    
    if (!chutesResponse.ok) {
      // Handle rate limiting (429) or other errors
      if (chutesResponse.status === 429) {
        console.warn(`Chutes API rate limited for chute_id=${chuteIdValue}`);
        return res.status(200).json({ chute_status: null, error: 'Rate limited. Please try again later.' });
      }
      console.error(`Chutes API returned ${chutesResponse.status} for chute_id=${chuteIdValue}`);
      return res.status(200).json({ chute_status: null, error: `Chutes API error: ${chutesResponse.status}` });
    }

    const chuteData = await chutesResponse.json();
    // Chutes API returns a boolean "hot" field: true = "hot", false = "cold"
    if (chuteData?.hot !== undefined) {
      const chuteStatus = chuteData.hot ? 'hot' : 'cold';
      return res.status(200).json({ chute_status: chuteStatus });
    }

    // If hot field is not present, return null
    return res.status(200).json({ chute_status: null, error: 'hot field not found in chute data' });
  } catch (error: any) {
    console.error(`Failed to fetch chute status for chute_id=${chuteIdValue}:`, error);
    return res.status(200).json({ chute_status: null, error: error.message });
  }
}

